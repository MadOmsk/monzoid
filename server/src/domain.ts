import { all, get, run, type Db } from './db.js';
import { potPriceHistory, potUnitValues } from './market.js';

export class DomainError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function nextYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function ymOf(date: string): string {
  return date.slice(0, 7);
}

export interface MonthFund {
  id: number;
  name: string;
  planned: number;
  spent: number;
  /** План минус факт за месяц */
  delta: number;
  /** Накоплено в фонде до этого месяца */
  balanceBefore: number;
  /** Переносы остатка за месяц: пришло минус ушло */
  moved: number;
  balanceAfter: number;
}

export interface MonthReport {
  ym: string;
  closed: boolean;
  income: number;
  plannedTotal: number;
  spentTotal: number;
  /** Доходы минус план, плюс корректировки, минус переводы в копилки */
  freeDelta: number;
  fundsDelta: number;
  adjustments: number;
  /** Переносы остатков в свободные минус из свободных в фонды */
  transfers: number;
  /** Переводы во вклады без активов */
  potMoves: number;
  /** Покупки активов минус продажи */
  assetMoves: number;
  /** Расходы по активам без фонда (агентские, нотариус): списываются прямо из свободных */
  assetCosts: number;
  freeBefore: number;
  freeAfter: number;
  fundsAfter: number;
  /** Стоимость вкладов по курсам и котировкам на конец месяца, без активов */
  potsAfter: number;
  /** Сколько во вклады вложено на конец месяца, без активов */
  potsInvested: number;
  /** Стоимость валютных вкладов (без акций) по курсу на конец месяца */
  currencyAfter: number;
  /** Стоимость акций по котировкам на конец месяца */
  stocksAfter: number;
  /** Вложено в валюту, акции и вклады в основной валюте на конец месяца: доход вкладки за период */
  currencyInvested: number;
  stocksInvested: number;
  cashInvested: number;
  /** Стоимость активов (недвижимость, машины) по последней оценке на конец месяца */
  assetsAfter: number;
  /** Сколько за активы заплачено */
  assetsInvested: number;
  /** Деньги: свободные средства + фонды, без вкладов и активов */
  moneyAfter: number;
  /** Деньги + вклады + активы */
  totalAfter: number;
  funds: MonthFund[];
}

/** Лимиты месяца наследуются от последнего месяца, где они заданы. */
export function ensurePlans(db: Db, ledgerId: number, ym: string): void {
  const has = get(db, 'SELECT 1 x FROM plans WHERE ledger_id = ? AND ym = ? LIMIT 1', ledgerId, ym);
  if (has) return;
  const source = get<{ ym: string }>(db, 'SELECT MAX(ym) ym FROM plans WHERE ledger_id = ? AND ym < ?', ledgerId, ym);
  if (!source?.ym) return;
  run(
    db,
    `INSERT INTO plans (ledger_id, ym, fund_id, amount)
     SELECT p.ledger_id, ?, p.fund_id, p.amount FROM plans p JOIN funds f ON f.id = p.fund_id
     WHERE p.ledger_id = ? AND p.ym = ? AND f.archived = 0`,
    ym,
    ledgerId,
    source.ym,
  );
}

export function isClosed(db: Db, ledgerId: number, ym: string): boolean {
  return !!get(db, 'SELECT 1 x FROM closed_months WHERE ledger_id = ? AND ym = ?', ledgerId, ym);
}

/** recalc: администратор согласился, что итоги закрытых месяцев пересчитаются по новым данным. */
export function assertWritable(db: Db, ledgerId: number, date: string, recalc = false): void {
  const ym = ymOf(date);
  const ledger = get<{ start_ym: string }>(db, 'SELECT start_ym FROM ledgers WHERE id = ?', ledgerId)!;
  if (ym < ledger.start_ym) throw new DomainError(`Дата ${date} раньше стартового месяца базы (${ledger.start_ym}).`);
  // 409 клиент понимает как «нужно согласие на пересчёт»
  if (!recalc && isClosed(db, ledgerId, ym)) throw new DomainError(`Месяц ${ym} закрыт. Изменение пересчитает итоги этого и следующих месяцев.`, 409);
}

/** Отчёты по всем месяцам от старта базы до toYm включительно. */
export function buildReports(db: Db, ledgerId: number, toYm: string): MonthReport[] {
  const ledger = get<{ start_ym: string }>(db, 'SELECT start_ym FROM ledgers WHERE id = ?', ledgerId);
  if (!ledger) throw new DomainError('База не найдена', 404);

  const funds = all<{ id: number; name: string; opening_balance: number; archived: number }>(
    db,
    'SELECT id, name, opening_balance, archived FROM funds WHERE ledger_id = ? ORDER BY sort, id',
    ledgerId,
  );
  const closed = new Set(all<{ ym: string }>(db, 'SELECT ym FROM closed_months WHERE ledger_id = ?', ledgerId).map((r) => r.ym));
  const plans = all<{ ym: string; fund_id: number; amount: number }>(db, 'SELECT ym, fund_id, amount FROM plans WHERE ledger_id = ?', ledgerId);
  const spent = all<{ ym: string; fund_id: number; total: number }>(
    db,
    `SELECT substr(date, 1, 7) ym, fund_id, SUM(amount) total FROM entries
     WHERE ledger_id = ? AND kind = 'expense' AND inactive_at IS NULL GROUP BY ym, fund_id`,
    ledgerId,
  );
  const incomes = all<{ ym: string; total: number }>(
    db,
    `SELECT substr(date, 1, 7) ym, SUM(amount) total FROM entries WHERE ledger_id = ? AND kind = 'income' AND inactive_at IS NULL GROUP BY ym`,
    ledgerId,
  );
  const adjustments = all<{ ym: string; total: number }>(
    db,
    'SELECT substr(date, 1, 7) ym, SUM(amount) total FROM adjustments WHERE ledger_id = ? AND inactive_at IS NULL GROUP BY ym',
    ledgerId,
  );
  const moves = all<{ ym: string; total: number }>(
    db,
    `SELECT substr(m.date, 1, 7) ym, SUM(m.amount) total FROM pot_moves m JOIN pots p ON p.id = m.pot_id
     WHERE p.ledger_id = ? AND p.kind != 'asset' AND m.inactive_at IS NULL GROUP BY ym`,
    ledgerId,
  );
  const assetMoves = all<{ ym: string; total: number }>(
    db,
    `SELECT substr(m.date, 1, 7) ym, SUM(m.amount) total FROM pot_moves m JOIN pots p ON p.id = m.pot_id
     WHERE p.ledger_id = ? AND p.kind = 'asset' AND m.inactive_at IS NULL GROUP BY ym`,
    ledgerId,
  );
  const potRows = all<{ id: number; kind: string; opening_balance: number; opening_units: number }>(db, 'SELECT id, kind, opening_balance, opening_units FROM pots WHERE ledger_id = ?', ledgerId);
  const assetIds = new Set(potRows.filter((p) => p.kind === 'asset').map((p) => p.id));
  const currencyIds = new Set(potRows.filter((p) => p.kind === 'currency').map((p) => p.id));
  const stockIds = new Set(potRows.filter((p) => p.kind === 'stock').map((p) => p.id));
  const valuations = assetValuations(db, ledgerId);
  const potMoves = all<{ ym: string; potId: number; amount: number; units: number }>(
    db,
    `SELECT substr(m.date, 1, 7) ym, m.pot_id potId, SUM(m.amount) amount, SUM(m.units) units FROM pot_moves m JOIN pots p ON p.id = m.pot_id
     WHERE p.ledger_id = ? AND m.inactive_at IS NULL GROUP BY ym, m.pot_id`,
    ledgerId,
  );
  const unitValues = potUnitValues(db, ledgerId);
  const priceHistory = potPriceHistory(db, ledgerId);
  // counted: у вклада было количество (валюта, акции). Тогда при нуле единиц он стоит 0, а не вложенную сумму:
  // разница между покупкой и продажей это доход или убыток, а не остаток
  const potHoldings = new Map(potRows.map((p) => [p.id, { invested: p.opening_balance, units: p.opening_units, counted: p.opening_units !== 0 }]));
  // Движения раньше первого месяца тоже входят в остаток
  const firstMoves = potMoves.filter((m) => m.ym < ledger.start_ym);
  for (const m of firstMoves) {
    const holding = potHoldings.get(m.potId)!;
    holding.invested += m.amount;
    holding.units += m.units;
    if (m.units) holding.counted = true;
  }

  // Переносы остатков: фонду пришло минус ушло; свободным то же, где фонд не указан
  const movedMap = new Map<string, number>();
  const freeMovedMap = new Map<string, number>();
  const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);
  for (const t of all<{ ym: string; fromId: number | null; toId: number | null; total: number }>(
    db,
    `SELECT substr(date, 1, 7) ym, from_fund_id fromId, to_fund_id toId, SUM(amount) total FROM fund_transfers
     WHERE ledger_id = ? AND inactive_at IS NULL GROUP BY ym, from_fund_id, to_fund_id`,
    ledgerId,
  )) {
    if (t.fromId === null) add(freeMovedMap, t.ym, -t.total);
    else add(movedMap, `${t.ym}|${t.fromId}`, -t.total);
    if (t.toId === null) add(freeMovedMap, t.ym, t.total);
    else add(movedMap, `${t.ym}|${t.toId}`, t.total);
  }

  const byYm = (rows: { ym: string; total: number }[]) => new Map(rows.map((r) => [r.ym, r.total]));
  const incomeMap = byYm(incomes);
  const adjustmentMap = byYm(adjustments);
  const moveMap = byYm(moves);
  const assetMoveMap = byYm(assetMoves);
  const planMap = new Map(plans.map((p) => [`${p.ym}|${p.fund_id}`, p.amount]));
  const spentMap = new Map(spent.map((s) => [`${s.ym}|${s.fund_id}`, s.total]));

  const balances = new Map(funds.map((f) => [f.id, f.opening_balance]));
  // Стартовые свободные задаются корректировкой первого месяца
  let free = 0;
  const reports: MonthReport[] = [];

  for (let ym = ledger.start_ym; ym <= toYm; ym = nextYm(ym)) {
    const monthFunds: MonthFund[] = [];
    let plannedTotal = 0;
    let spentTotal = 0;
    let movedTotal = 0;
    for (const fund of funds) {
      const planned = planMap.get(`${ym}|${fund.id}`) ?? 0;
      const fundSpent = spentMap.get(`${ym}|${fund.id}`) ?? 0;
      const moved = movedMap.get(`${ym}|${fund.id}`) ?? 0;
      const balanceBefore = balances.get(fund.id)!;
      const delta = planned - fundSpent;
      balances.set(fund.id, balanceBefore + delta + moved);
      plannedTotal += planned;
      spentTotal += fundSpent;
      movedTotal += moved;
      if (!fund.archived || planned || fundSpent || moved || balanceBefore) {
        monthFunds.push({ id: fund.id, name: fund.name, planned, spent: fundSpent, delta, balanceBefore, moved, balanceAfter: balanceBefore + delta + moved });
      }
    }
    const income = incomeMap.get(ym) ?? 0;
    const adj = adjustmentMap.get(ym) ?? 0;
    const movedToPots = moveMap.get(ym) ?? 0;
    const movedToAssets = assetMoveMap.get(ym) ?? 0;
    const assetCosts = spentMap.get(`${ym}|null`) ?? 0;
    const transfers = freeMovedMap.get(ym) ?? 0;
    const freeDelta = income - plannedTotal + adj + transfers - movedToPots - movedToAssets - assetCosts;
    const freeBefore = free;
    free += freeDelta;
    for (const m of potMoves) {
      if (m.ym !== ym) continue;
      const holding = potHoldings.get(m.potId)!;
      holding.invested += m.amount;
      holding.units += m.units;
      if (m.units) holding.counted = true;
    }
    let potsInvested = 0;
    let currency = 0;
    let stocks = 0;
    let currencyInvested = 0;
    let stocksInvested = 0;
    let cashInvested = 0;
    let pots = 0;
    let assetsInvested = 0;
    let assets = 0;
    const monthEnd = `${ym}-31`;
    for (const [id, holding] of potHoldings) {
      if (assetIds.has(id)) {
        assetsInvested += holding.invested;
        assets += assetValue(holding, valuations.filter((v) => v.potId === id && v.date <= monthEnd).at(-1)?.value);
        continue;
      }
      // Цена на конец месяца; для месяцев раньше первой фиксации берётся ближайшая более поздняя, затем текущая
      const unit = priceHistory.find((p) => p.potId === id && p.ym >= ym)?.unit ?? unitValues.get(id);
      potsInvested += holding.invested;
      const worth = unit !== undefined && (holding.units !== 0 || holding.counted) ? Math.round(holding.units * unit) : holding.invested;
      pots += worth;
      if (currencyIds.has(id)) { currency += worth; currencyInvested += holding.invested; }
      else if (stockIds.has(id)) { stocks += worth; stocksInvested += holding.invested; }
      else cashInvested += holding.invested;
    }
    const fundsAfter = [...balances.values()].reduce((a, b) => a + b, 0);
    reports.push({
      ym,
      closed: closed.has(ym),
      income,
      plannedTotal,
      spentTotal,
      freeDelta,
      fundsDelta: plannedTotal - spentTotal + movedTotal,
      adjustments: adj,
      transfers,
      potMoves: movedToPots,
      assetMoves: movedToAssets,
      assetCosts,
      freeBefore,
      freeAfter: free,
      fundsAfter,
      potsAfter: pots,
      potsInvested,
      currencyAfter: currency,
      stocksAfter: stocks,
      currencyInvested,
      stocksInvested,
      cashInvested,
      assetsAfter: assets,
      assetsInvested,
      moneyAfter: free + fundsAfter,
      totalAfter: free + fundsAfter + pots + assets,
      funds: monthFunds,
    });
  }
  return reports;
}

/** Действующие оценки активов базы по возрастанию даты. */
export function assetValuations(db: Db, ledgerId: number) {
  return all<{ id: number; potId: number; date: string; value: number }>(
    db,
    `SELECT v.id, v.pot_id potId, v.date, v.value FROM asset_values v JOIN pots p ON p.id = v.pot_id
     WHERE p.ledger_id = ? AND v.inactive_at IS NULL ORDER BY v.date, v.id`,
    ledgerId,
  );
}

/**
 * Стоимость актива: последняя оценка, а без неё уплаченная сумма. Проданный актив стоит 0:
 * разница между оценкой и ценой продажи уже меняет итог капитала через свободные средства.
 */
export function assetValue(holding: { invested: number; units: number; counted: boolean }, valuation: number | undefined): number {
  if (holding.units <= 0) return holding.counted ? 0 : holding.invested;
  return valuation ?? holding.invested;
}

export interface PaceAlert {
  fundId: number;
  name: string;
  /** Какая доля месяца прошла, в процентах */
  checkpoint: number;
  /** Последний день месяца, вошедший в сравнение */
  day: number;
  spent: number;
  planned: number;
  /** Число, когда в таком темпе кончится лимит; null, если он уже исчерпан */
  runOutDay: number | null;
}

const PACE_CHECKPOINTS = [75, 50, 25];

/**
 * Сравнивает траты с лимитом на последней пройденной отметке месяца (25%, 50%, 75%).
 * Считаются только траты до дня отметки, поэтому вывод не меняется до следующей отметки.
 */
export function paceAlerts(db: Db, ledgerId: number, ym: string, today: string): PaceAlert[] {
  if (ymOf(today) !== ym || isClosed(db, ledgerId, ym)) return [];
  const [year, month] = ym.split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const todayDay = Number(today.slice(8, 10));
  const checkpoint = PACE_CHECKPOINTS.find((c) => todayDay >= Math.ceil((days * c) / 100));
  if (!checkpoint) return [];
  const day = Math.ceil((days * checkpoint) / 100);
  const rows = all<{ fundId: number; name: string; planned: number; spent: number }>(
    db,
    `SELECT f.id fundId, f.name, p.amount planned,
       COALESCE((SELECT SUM(e.amount) FROM entries e WHERE e.ledger_id = f.ledger_id AND e.fund_id = f.id AND e.kind = 'expense' AND e.inactive_at IS NULL AND e.date >= ? AND e.date <= ?), 0) spent
     FROM funds f JOIN plans p ON p.fund_id = f.id AND p.ledger_id = f.ledger_id AND p.ym = ?
     WHERE f.ledger_id = ? AND f.archived = 0 AND f.pace_alert = 1 AND f.credit_user_id IS NULL AND p.amount > 0 ORDER BY f.sort, f.id`,
    `${ym}-01`,
    `${ym}-${String(day).padStart(2, '0')}`,
    ym,
    ledgerId,
  );
  return rows
    .filter((r) => r.spent * 100 > r.planned * checkpoint)
    .map((r) => ({ ...r, checkpoint, day, runOutDay: r.spent >= r.planned ? null : Math.ceil((r.planned * day) / r.spent) }));
}

/**
 * Личные фонды, операции которых этому человеку не показываются: чужие, если владелец включил скрытие.
 * Администратор видит всё. Итоги месяцев это не меняет, скрываются только сами операции.
 */
export function hiddenFundIds(db: Db, ledgerId: number, viewerId: number, isAdmin: boolean): Set<number> {
  if (isAdmin) return new Set();
  return new Set(all<{ id: number }>(
    db,
    `SELECT f.id FROM funds f JOIN members m ON m.ledger_id = f.ledger_id AND m.user_id = f.owner_user_id
     WHERE f.ledger_id = ? AND m.hide_personal = 1 AND m.inactive_at IS NULL AND m.user_id <> ?`,
    ledgerId,
    viewerId,
  ).map((r) => r.id));
}

/** Сколько база должна каждому участнику: его расходы минус возвраты минус выплаты. */
export function memberDebts(db: Db, ledgerId: number): { userId: number; name: string; owed: number; settledUntil: string | null; credited: number }[] {
  return all<{ userId: number; name: string; owed: number; settledUntil: string | null; credited: number }>(
    db,
    `SELECT m.user_id userId, m.display_name name, m.settled_until settledUntil,
       EXISTS (SELECT 1 FROM funds f WHERE f.ledger_id = m.ledger_id AND f.credit_user_id = m.user_id AND f.archived = 0) credited,
       COALESCE((SELECT SUM(e.amount) FROM entries e WHERE e.ledger_id = m.ledger_id AND e.paid_by = m.user_id AND e.inactive_at IS NULL), 0)
       - COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.ledger_id = m.ledger_id AND s.user_id = m.user_id AND s.inactive_at IS NULL), 0) owed
     FROM members m WHERE m.ledger_id = ? AND m.inactive_at IS NULL ORDER BY m.role, m.display_name`,
    ledgerId,
  );
}

/**
 * Начисление участнику: каждый открытый месяц в фонде есть расход на сумму плана, оплаченный участником.
 * Так остаток фонда остаётся нулевым, а долг базы растёт. Запись следует за планом и закрытые месяцы не трогает.
 */
export function syncCredits(db: Db, ledgerId: number, currentYm: string): void {
  const funds = all<{ id: number; name: string; credit_user_id: number; credit_from: string }>(
    db,
    'SELECT id, name, credit_user_id, credit_from FROM funds WHERE ledger_id = ? AND credit_user_id IS NOT NULL AND archived = 0',
    ledgerId,
  );
  if (!funds.length) return;
  const ledger = get<{ start_ym: string; created_by: number }>(db, 'SELECT start_ym, created_by FROM ledgers WHERE id = ?', ledgerId)!;
  for (const fund of funds) {
    if (!get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, fund.credit_user_id)) continue;
    const from = fund.credit_from < ledger.start_ym ? ledger.start_ym : fund.credit_from;
    for (let ym = from; ym <= currentYm; ym = nextYm(ym)) {
      if (isClosed(db, ledgerId, ym)) continue;
      ensurePlans(db, ledgerId, ym);
      const planned = get<{ amount: number }>(db, 'SELECT amount FROM plans WHERE ledger_id = ? AND ym = ? AND fund_id = ?', ledgerId, ym, fund.id)?.amount ?? 0;
      const entry = get<{ id: number; amount: number; paid_by: number }>(
        db,
        `SELECT id, amount, paid_by FROM entries WHERE ledger_id = ? AND fund_id = ? AND auto_credit = 1 AND inactive_at IS NULL AND substr(date, 1, 7) = ?`,
        ledgerId,
        fund.id,
        ym,
      );
      if (!entry && planned > 0) {
        run(
          db,
          `INSERT INTO entries (ledger_id, date, kind, amount, fund_id, description, paid_by, created_by, auto_credit)
           VALUES (?, ?, 'expense', ?, ?, 'Начисление по плану фонда', ?, ?, 1)`,
          ledgerId,
          `${ym}-01`,
          planned,
          fund.id,
          fund.credit_user_id,
          ledger.created_by,
        );
      } else if (entry && planned <= 0) {
        run(db, `UPDATE entries SET inactive_at = datetime('now') WHERE id = ?`, entry.id);
      } else if (entry && (entry.amount !== planned || entry.paid_by !== fund.credit_user_id)) {
        run(db, 'UPDATE entries SET amount = ?, paid_by = ? WHERE id = ?', planned, fund.credit_user_id, entry.id);
      }
    }
  }
}

/** Выключение снимает начисления открытых месяцев; закрытые остаются как есть. */
export function stopCredits(db: Db, ledgerId: number, fundId: number): void {
  run(
    db,
    `UPDATE entries SET inactive_at = datetime('now') WHERE ledger_id = ? AND fund_id = ? AND auto_credit = 1 AND inactive_at IS NULL
       AND substr(date, 1, 7) NOT IN (SELECT ym FROM closed_months WHERE ledger_id = ?)`,
    ledgerId,
    fundId,
    ledgerId,
  );
}

/** Виртуальные участники получают отрицательный ID: у настоящих пользователей Telegram он всегда положительный. */
export function isVirtual(userId: number): boolean {
  return userId < 0;
}

export function createVirtualMember(db: Db, ledgerId: number, name: string): number {
  const id = get<{ id: number }>(db, 'SELECT MIN(COALESCE((SELECT MIN(id) FROM users), 0), 0) - 1 id')!.id;
  run(db, 'INSERT INTO users (id, name) VALUES (?, ?)', id, name);
  run(db, `INSERT INTO members (ledger_id, user_id, role, display_name) VALUES (?, ?, 'member', ?)`, ledgerId, id, name);
  return id;
}

/** Передаёт всю историю виртуального участника настоящему. Вызывается внутри транзакции. */
export function mergeVirtualMember(db: Db, ledgerId: number, virtualId: number, realId: number): void {
  if (!isVirtual(virtualId) || isVirtual(realId)) throw new DomainError('Связать можно только виртуального участника с настоящим.');
  const member = get<{ display_name: string }>(db, 'SELECT display_name FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, virtualId);
  if (!member) throw new DomainError('Виртуальный участник не найден. Возможно, он уже связан.', 404);
  // Список ссылок общий с выходом из базы (MEMBER_LINKS); очередь выписок только здесь: при выходе она остаётся за человеком
  for (const [table, column] of [...MEMBER_LINKS, ['statement_queue', 'user_id']]) {
    run(db, `UPDATE ${table} SET ${column} = ? WHERE ledger_id = ? AND ${column} = ?`, realId, ledgerId, virtualId);
  }
  if (get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ?', ledgerId, realId)) {
    // Человек мог быть убран из базы раньше: ссылка возвращает его
    run(db, 'UPDATE members SET inactive_at = NULL WHERE ledger_id = ? AND user_id = ?', ledgerId, realId);
    run(db, `UPDATE members SET inactive_at = datetime('now') WHERE ledger_id = ? AND user_id = ?`, ledgerId, virtualId);
  } else {
    // Человек сохраняет имя, под которым его уже знают в этой базе
    run(db, 'UPDATE members SET user_id = ?, former_user_id = NULL WHERE ledger_id = ? AND user_id = ?', realId, ledgerId, virtualId);
  }
  run(db, 'DELETE FROM invites WHERE virtual_user_id = ?', virtualId);
}

// Ссылки на участника внутри базы, которые переходят вместе с его историей
const MEMBER_LINKS: [string, string][] = [
  ['entries', 'paid_by'],
  ['entries', 'earned_by'],
  ['entries', 'created_by'],
  ['settlements', 'user_id'],
  ['settlements', 'created_by'],
  ['import_batches', 'user_id'],
  ['import_rows', 'suggested_user_id'],
  ['funds', 'credit_user_id'],
  ['funds', 'owner_user_id'],
];

/** Что будет при выходе участника из базы: долг, кому перейдут права администратора, или почему выйти нельзя. */
export function leavePreview(db: Db, ledgerId: number, userId: number) {
  const me = get<{ role: string }>(db, 'SELECT role FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, userId);
  if (!me) throw new DomainError('Ты не участник этой базы.', 404);
  const owed = memberDebts(db, ledgerId).find((d) => d.userId === userId)?.owed ?? 0;
  const otherAdmins = get<{ c: number }>(db, `SELECT COUNT(*) c FROM members WHERE ledger_id = ? AND role = 'admin' AND inactive_at IS NULL AND user_id <> ?`, ledgerId, userId)!.c;
  // Без администратора базой некому управлять: права переходят первому из оставшихся людей с аккаунтом
  const heir = me.role === 'admin' && !otherAdmins
    ? get<{ user_id: number; display_name: string }>(db, 'SELECT user_id, display_name FROM members WHERE ledger_id = ? AND inactive_at IS NULL AND user_id > 0 AND user_id <> ? ORDER BY rowid LIMIT 1', ledgerId, userId) ?? null
    : null;
  const blocked = me.role === 'admin' && !otherAdmins && !heir ? 'Ты последний участник с аккаунтом: после выхода в базу никто не сможет зайти. Сначала пригласи кого-нибудь или просто заблокируй базу.' : null;
  return { owed, heir: heir ? { userId: heir.user_id, name: heir.display_name } : null, blocked };
}

/**
 * Выход из базы: профиль остаётся со всей историей, но без аккаунта, как виртуальный участник. Администратор работает
 * с ним вручную, а если человек снова войдёт по приглашению, он прицепится к этому же профилю. Вызывается внутри транзакции.
 */
export function leaveLedger(db: Db, ledgerId: number, userId: number): number {
  const preview = leavePreview(db, ledgerId, userId);
  if (preview.blocked) throw new DomainError(preview.blocked);
  if (preview.heir) run(db, `UPDATE members SET role = 'admin' WHERE ledger_id = ? AND user_id = ?`, ledgerId, preview.heir.userId);
  const name = get<{ display_name: string }>(db, 'SELECT display_name FROM members WHERE ledger_id = ? AND user_id = ?', ledgerId, userId)!.display_name;
  const virtualId = get<{ id: number }>(db, 'SELECT MIN(COALESCE((SELECT MIN(id) FROM users), 0), 0) - 1 id')!.id;
  run(db, 'INSERT INTO users (id, name) VALUES (?, ?)', virtualId, name);
  for (const [table, column] of MEMBER_LINKS) run(db, `UPDATE ${table} SET ${column} = ? WHERE ledger_id = ? AND ${column} = ?`, virtualId, ledgerId, userId);
  run(db, `UPDATE members SET user_id = ?, role = 'member', notify = 1, former_user_id = ? WHERE ledger_id = ? AND user_id = ?`, virtualId, userId, ledgerId, userId);
  // Личные напоминания и неотправленные уведомления по этой базе больше не нужны
  run(db, `UPDATE reminders SET inactive_at = datetime('now') WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL`, ledgerId, userId);
  run(db, 'DELETE FROM notices WHERE ledger_id = ? AND recipient_id = ?', ledgerId, userId);
  return virtualId;
}

/** Месяцы закрываются строго по порядку: иначе накопительные итоги перестанут совпадать. */
export function closeMonth(db: Db, ledgerId: number, ym: string): void {
  const ledger = get<{ start_ym: string }>(db, 'SELECT start_ym FROM ledgers WHERE id = ?', ledgerId)!;
  const last = get<{ ym: string | null }>(db, 'SELECT MAX(ym) ym FROM closed_months WHERE ledger_id = ?', ledgerId)?.ym;
  const expected = last ? nextYm(last) : ledger.start_ym;
  if (ym !== expected) throw new DomainError(`Сейчас можно закрыть только месяц ${expected}.`);
  ensurePlans(db, ledgerId, ym);
  run(db, 'INSERT INTO closed_months (ledger_id, ym) VALUES (?, ?)', ledgerId, ym);
}

export function reopenMonth(db: Db, ledgerId: number, ym: string): void {
  const last = get<{ ym: string | null }>(db, 'SELECT MAX(ym) ym FROM closed_months WHERE ledger_id = ?', ledgerId)?.ym;
  if (ym !== last) throw new DomainError('Открыть заново можно только последний закрытый месяц.');
  run(db, 'DELETE FROM closed_months WHERE ledger_id = ? AND ym = ?', ledgerId, ym);
}
