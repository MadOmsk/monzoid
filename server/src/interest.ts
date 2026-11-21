import { all, get, run, type Db } from './db.js';
import { DomainError } from './domain.js';

/**
 * Как часто банк прибавляет проценты к вкладу. Считаются они каждый день с остатка, а прибавляются раз в период,
 * и уже после этого тоже приносят проценты. Каждый день: проценты прибавляются ежедневно, а подтверждаются
 * одной суммой, когда удобно (напоминание раз в месяц).
 */
export type Payout = 'day' | 'month' | 'quarter' | 'year';
export const PAYOUTS: Payout[] = ['day', 'month', 'quarter', 'year'];
/** Шаг между начислениями в месяцах; у ежедневного это шаг напоминания */
const STEP: Record<Payout, number> = { day: 1, month: 1, quarter: 3, year: 12 };
const DAYS_IN_YEAR = 365;

/** Дата через n месяцев с тем же числом; 31 января + 1 месяц это последний день февраля. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface DepositInput {
  /** Номинальная ставка в процентах годовых; null убирает депозит */
  rate?: number | null;
  payout?: Payout;
  /** Дата открытия: проценты идут со следующего дня */
  rateFrom?: string;
  /** Дата первой выплаты, дальше выплаты с шагом периода в тот же день месяца; null значит через период от открытия */
  payoutFirst?: string | null;
}

/** Ставка, выплаты и даты депозита у вклада в основной валюте; не переданное остаётся прежним. */
export function saveDeposit(db: Db, potId: number, input: DepositInput): void {
  if (input.rate === null) {
    run(db, 'UPDATE pots SET rate = NULL WHERE id = ?', potId);
    return;
  }
  const current = get<{ rate: number | null; payout: Payout | null; rateFrom: string | null; payoutFirst: string | null }>(
    db,
    'SELECT rate, payout, rate_from rateFrom, payout_first payoutFirst FROM pots WHERE id = ?',
    potId,
  )!;
  const rate = input.rate ?? current.rate;
  const payout = input.payout ?? current.payout ?? 'month';
  const from = input.rateFrom ?? current.rateFrom;
  // У ежедневного начисления дня выплаты нет
  const first = payout === 'day' ? null : input.payoutFirst !== undefined ? input.payoutFirst : current.payoutFirst;
  if (!rate || !from) throw new DomainError('Укажи ставку и дату открытия депозита.');
  if (first && first <= from) throw new DomainError('Первая выплата должна быть позже открытия депозита.');
  if (first && first > addMonths(from, STEP[payout])) throw new DomainError('Первая выплата должна быть не позже, чем через период после открытия.');
  run(db, 'UPDATE pots SET rate = ?, payout = ?, rate_from = ?, payout_first = ? WHERE id = ?', rate, payout, from, first ?? null, potId);
}

export interface InterestPeriod {
  from: string;
  to: string;
  /** Посчитанные проценты в тиынах; человек может поправить сумму перед начислением */
  amount: number;
}

/**
 * Следующие проценты по депозиту (вклад в основной валюте со ставкой). Начисления идут в день первой выплаты
 * и дальше с шагом периода. Проценты за день: остаток на конец прошлого дня × ставка / 365, за период они
 * складываются. Начисленные проценты лежат во вкладе, поэтому следующий период считается уже с ними (сложный
 * процент). При ежедневном начислении каждый день считается и с набежавших процентов, а период идёт по сегодня.
 * Пополнения и снятия внутри периода учитываются с их даты.
 * due: проценты, которые можно начислить; remind: пора напомнить (у ежедневного раз в месяц); next: следующее начисление.
 */
export function nextInterest(db: Db, potId: number, today: string): { due: InterestPeriod | null; remind: boolean; next: string | null } {
  const pot = get<{ kind: string; rate: number | null; payout: Payout | null; rateFrom: string | null; first: string | null; skipped: string | null; opening: number }>(
    db,
    'SELECT kind, rate, payout, rate_from rateFrom, payout_first first, interest_skipped skipped, opening_balance opening FROM pots WHERE id = ?',
    potId,
  );
  if (!pot || pot.kind !== 'cash' || !pot.rate || !pot.payout || !pot.rateFrom) return { due: null, remind: false, next: null };
  const confirmed = get<{ date: string | null }>(db, `SELECT MAX(date) date FROM entries WHERE pot_id = ? AND kind = 'income' AND inactive_at IS NULL`, potId)?.date;
  const start = [pot.rateFrom, confirmed, pot.skipped].filter((d): d is string => !!d).sort().at(-1)!;
  const daily = pot.payout === 'day';
  let from: string;
  let to: string;
  if (daily) {
    // Начислить можно по сегодня, напоминание через месяц после прошлого начисления
    if (start >= today) return { due: null, remind: false, next: addDays(today, 1) };
    from = start;
    to = today;
  } else {
    // Выплаты идут от первой (по умолчанию через период после открытия) с шагом периода; первый период может быть короче
    const step = STEP[pot.payout];
    const first = pot.first ?? addMonths(pot.rateFrom, step);
    let k = 0;
    while (addMonths(first, k * step) <= start) k++;
    to = addMonths(first, k * step);
    if (to > today) return { due: null, remind: false, next: to };
    from = [k === 0 ? pot.rateFrom : addMonths(first, (k - 1) * step), start].sort().at(-1)!;
  }

  const moves = all<{ date: string; amount: number }>(db, 'SELECT date, amount FROM pot_moves WHERE pot_id = ? AND inactive_at IS NULL ORDER BY date', potId);
  let balance = pot.opening + moves.filter((m) => m.date <= from).reduce((s, m) => s + m.amount, 0);
  let i = moves.findIndex((m) => m.date > from);
  if (i < 0) i = moves.length;
  let total = 0;
  for (let day = addDays(from, 1); day <= to; day = addDays(day, 1)) {
    // Деньги, положенные в день, приносят проценты со следующего дня; при ежедневном начислении и набежавшие проценты
    total += (Math.max(balance + (daily ? total : 0), 0) * pot.rate) / 100 / DAYS_IN_YEAR;
    while (i < moves.length && moves[i].date <= day) balance += moves[i++].amount;
  }
  return { due: { from, to, amount: Math.round(total) }, remind: !daily || addMonths(from, 1) <= today, next: daily ? addDays(today, 1) : to };
}

/**
 * Записи во вкладе, которые следуют за операцией (pot_moves.entry_id): правка, удаление и отмена операции переносятся сюда.
 * Проценты по депозиту записываются доходом с привязкой к вкладу (entries.pot_id), а во вкладе появляется
 * вложение на ту же сумму и дату. Свободные средства не меняются, доход виден в статистике.
 * Расход фонда, оплаченный из вклада в валюте или акциях (entries.pot_units): во вкладе продажа этих единиц
 * на сумму расхода. Деньги от продажи приходят в свободные, а расход забирает столько же из фонда.
 */
export function syncInterest(db: Db, ledgerId: number): void {
  const linked = all<{ id: number; potId: number; date: string; amount: number; units: number; comment: string }>(
    db,
    `SELECT e.id, e.pot_id potId, e.date, e.amount, 0 units, 'Проценты' comment FROM entries e JOIN pots p ON p.id = e.pot_id
     WHERE e.ledger_id = ? AND e.kind = 'income' AND p.kind = 'cash' AND e.inactive_at IS NULL
     UNION ALL
     SELECT e.id, e.pot_id, e.date, -e.amount, -e.pot_units,
       'Оплата: ' || CASE WHEN e.comment <> '' THEN e.comment WHEN e.description <> '' THEN e.description ELSE COALESCE(f.name, 'расход') END
     FROM entries e JOIN pots p ON p.id = e.pot_id LEFT JOIN funds f ON f.id = e.fund_id
     WHERE e.ledger_id = ? AND e.kind = 'expense' AND p.kind IN ('currency', 'stock') AND e.pot_units > 0 AND e.inactive_at IS NULL`,
    ledgerId,
    ledgerId,
  );
  const wanted = new Map(linked.map((e) => [e.id, e]));
  const existing = all<{ id: number; entryId: number; potId: number; date: string; amount: number; units: number; comment: string }>(
    db,
    `SELECT m.id, m.entry_id entryId, m.pot_id potId, m.date, m.amount, m.units, m.comment FROM pot_moves m JOIN pots p ON p.id = m.pot_id
     WHERE p.ledger_id = ? AND m.entry_id IS NOT NULL AND m.sale_move_id IS NULL AND m.inactive_at IS NULL`,
    ledgerId,
  );
  for (const row of existing) {
    const want = wanted.get(row.entryId);
    wanted.delete(row.entryId);
    if (!want) run(db, `UPDATE pot_moves SET inactive_at = datetime('now') WHERE id = ?`, row.id);
    else if (want.potId !== row.potId || want.date !== row.date || want.amount !== row.amount || want.units !== row.units || want.comment !== row.comment) {
      run(db, 'UPDATE pot_moves SET pot_id = ?, date = ?, amount = ?, units = ?, comment = ? WHERE id = ?', want.potId, want.date, want.amount, want.units, want.comment, row.id);
    }
  }
  for (const e of wanted.values()) {
    run(db, 'INSERT INTO pot_moves (pot_id, date, amount, units, comment, entry_id) VALUES (?, ?, ?, ?, ?, ?)', e.potId, e.date, e.amount, e.units, e.comment, e.id);
  }
}
