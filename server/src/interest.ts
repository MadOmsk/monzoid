import { all, get, run, type Db } from './db.js';

/** Как часто банк выплачивает проценты по депозиту. Выплата прибавляется к вкладу, поэтому проценты сложные. */
export type Payout = 'month' | 'quarter' | 'year';
export const PAYOUTS: Payout[] = ['month', 'quarter', 'year'];
const STEP: Record<Payout, number> = { month: 1, quarter: 3, year: 12 };
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

export interface InterestPeriod {
  from: string;
  to: string;
  /** Посчитанные проценты в тиынах; человек может поправить сумму перед начислением */
  amount: number;
}

/**
 * Следующие проценты по депозиту (вклад в основной валюте со ставкой). Периоды идут от даты открытия с шагом выплаты.
 * Проценты за день: остаток на конец прошлого дня × ставка / 365; за период они складываются. Начисленные проценты
 * лежат во вкладе, поэтому следующий период считается уже с ними (сложный процент). Пополнения и снятия внутри
 * периода учитываются с их даты.
 * due: период, который закончился и ждёт подтверждения; next: когда закончится следующий.
 */
export function nextInterest(db: Db, potId: number, today: string): { due: InterestPeriod | null; next: string | null } {
  const pot = get<{ kind: string; rate: number | null; payout: Payout | null; rateFrom: string | null; skipped: string | null; opening: number }>(
    db,
    'SELECT kind, rate, payout, rate_from rateFrom, interest_skipped skipped, opening_balance opening FROM pots WHERE id = ?',
    potId,
  );
  if (!pot || pot.kind !== 'cash' || !pot.rate || !pot.payout || !pot.rateFrom) return { due: null, next: null };
  const confirmed = get<{ date: string | null }>(db, `SELECT MAX(date) date FROM entries WHERE pot_id = ? AND kind = 'income' AND inactive_at IS NULL`, potId)?.date;
  const start = [pot.rateFrom, confirmed, pot.skipped].filter((d): d is string => !!d).sort().at(-1)!;
  // Первый конец периода после уже начисленного
  let k = 1;
  while (addMonths(pot.rateFrom, k * STEP[pot.payout]) <= start) k++;
  const to = addMonths(pot.rateFrom, k * STEP[pot.payout]);
  if (to > today) return { due: null, next: to };
  const from = [addMonths(pot.rateFrom, (k - 1) * STEP[pot.payout]), start].sort().at(-1)!;

  const moves = all<{ date: string; amount: number }>(db, 'SELECT date, amount FROM pot_moves WHERE pot_id = ? AND inactive_at IS NULL ORDER BY date', potId);
  let balance = pot.opening + moves.filter((m) => m.date <= from).reduce((s, m) => s + m.amount, 0);
  let i = moves.findIndex((m) => m.date > from);
  if (i < 0) i = moves.length;
  let total = 0;
  for (let day = addDays(from, 1); day <= to; day = addDays(day, 1)) {
    // Деньги, положенные в день, приносят проценты со следующего дня
    total += (Math.max(balance, 0) * pot.rate) / 100 / DAYS_IN_YEAR;
    while (i < moves.length && moves[i].date <= day) balance += moves[i++].amount;
  }
  return { due: { from, to, amount: Math.round(total) }, next: to };
}

/**
 * Проценты по депозиту записываются доходом с привязкой к вкладу (entries.pot_id), а во вкладе появляется
 * вложение на ту же сумму и дату (pot_moves.entry_id). Свободные средства не меняются, доход виден в статистике.
 * Вложение следует за доходом: правка, удаление и отмена дохода переносятся сюда.
 */
export function syncInterest(db: Db, ledgerId: number): void {
  const incomes = all<{ id: number; potId: number; date: string; amount: number }>(
    db,
    `SELECT e.id, e.pot_id potId, e.date, e.amount FROM entries e JOIN pots p ON p.id = e.pot_id
     WHERE e.ledger_id = ? AND e.kind = 'income' AND p.kind = 'cash' AND e.inactive_at IS NULL`,
    ledgerId,
  );
  const wanted = new Map(incomes.map((e) => [e.id, e]));
  const existing = all<{ id: number; entryId: number; potId: number; date: string; amount: number }>(
    db,
    `SELECT m.id, m.entry_id entryId, m.pot_id potId, m.date, m.amount FROM pot_moves m JOIN pots p ON p.id = m.pot_id
     WHERE p.ledger_id = ? AND m.entry_id IS NOT NULL AND m.sale_move_id IS NULL AND m.inactive_at IS NULL`,
    ledgerId,
  );
  for (const row of existing) {
    const want = wanted.get(row.entryId);
    wanted.delete(row.entryId);
    if (!want) run(db, `UPDATE pot_moves SET inactive_at = datetime('now') WHERE id = ?`, row.id);
    else if (want.potId !== row.potId || want.date !== row.date || want.amount !== row.amount) {
      run(db, 'UPDATE pot_moves SET pot_id = ?, date = ?, amount = ? WHERE id = ?', want.potId, want.date, want.amount, row.id);
    }
  }
  for (const e of wanted.values()) {
    run(db, `INSERT INTO pot_moves (pot_id, date, amount, units, comment, entry_id) VALUES (?, ?, ?, 0, 'Проценты', ?)`, e.potId, e.date, e.amount, e.id);
  }
}
