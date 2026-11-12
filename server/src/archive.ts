import { all, get, run, type Db } from './db.js';
import { logChange, snapshot } from './changes.js';
import { buildReports, DomainError, isClosed, ymOf } from './domain.js';

/**
 * Архивация фонда. Три способа:
 * keep: операции остаются в фонде, остаток переносится в свободные или в другой фонд;
 * move: все операции, планы и стартовый остаток переезжают в другой фонд;
 * split: операции разносятся по фондам, план каждого месяца переезжает вслед за операциями, остаток переносится.
 * Во всех случаях снимается план с текущего месяца вперёд. Всё, что сделано, записывается в fund_archives,
 * поэтому архивацию можно отменить одной кнопкой.
 */
export type ArchiveMode = 'keep' | 'move' | 'split';

export interface ArchiveRequest {
  mode: ArchiveMode;
  /** move: куда переезжает всё; split: фонд по умолчанию для операций без явного выбора */
  targetFundId: number | null;
  /** keep и split: куда уйдёт остаток; null = свободные */
  balanceToFundId: number | null;
  /** split: фонд для отдельных операций */
  assignments: { entryId: number; fundId: number }[];
  recalc: boolean;
}

type PlanDelta = [string, number, number];

function fundBalance(db: Db, ledgerId: number, fundId: number, ym: string): number {
  const report = buildReports(db, ledgerId, ym).at(-1);
  return report?.funds.find((f) => f.id === fundId)?.balanceAfter ?? get<{ opening_balance: number }>(db, 'SELECT opening_balance FROM funds WHERE id = ?', fundId)!.opening_balance;
}

function activeFund(db: Db, ledgerId: number, fundId: number, what: string) {
  const fund = get<{ id: number; name: string; archived: number; owner_user_id: number | null; opening_balance: number }>(
    db,
    'SELECT id, name, archived, owner_user_id, opening_balance FROM funds WHERE id = ? AND ledger_id = ?',
    fundId,
    ledgerId,
  );
  if (!fund) throw new DomainError(`${what} не найден`, 404);
  return fund;
}

/** Что есть у фонда: показывается перед архивацией. */
export function archivePreview(db: Db, ledgerId: number, fundId: number, currentYm: string) {
  const fund = activeFund(db, ledgerId, fundId, 'Фонд');
  const entries = all<{ id: number; date: string; amount: number; comment: string; description: string; closed: number }>(
    db,
    `SELECT e.id, e.date, e.amount, e.comment, e.description,
       EXISTS (SELECT 1 FROM closed_months c WHERE c.ledger_id = e.ledger_id AND c.ym = substr(e.date, 1, 7)) closed
     FROM entries e WHERE e.ledger_id = ? AND e.fund_id = ? AND e.inactive_at IS NULL AND e.auto_credit = 0 ORDER BY e.date DESC, e.id DESC`,
    ledgerId,
    fundId,
  ).map((e) => ({ ...e, closed: !!e.closed }));
  const futurePlan = get<{ s: number }>(db, 'SELECT COALESCE(SUM(amount), 0) s FROM plans WHERE ledger_id = ? AND fund_id = ? AND ym >= ?', ledgerId, fundId, currentYm)!.s;
  const plans = get<{ n: number }>(db, 'SELECT COUNT(*) n FROM plans WHERE ledger_id = ? AND fund_id = ? AND amount <> 0', ledgerId, fundId)!.n;
  return {
    name: fund.name,
    personal: fund.owner_user_id !== null,
    balance: fundBalance(db, ledgerId, fundId, currentYm),
    futurePlan,
    entries,
    closedEntries: entries.filter((e) => e.closed).length,
    empty: !entries.length && !plans && !fund.opening_balance,
  };
}

/** Меняет план фонда на delta и записывает изменение для отмены. */
function shiftPlan(db: Db, ledgerId: number, ym: string, fundId: number, delta: number, log: PlanDelta[]): void {
  if (!delta) return;
  run(
    db,
    `INSERT INTO plans (ledger_id, ym, fund_id, amount) VALUES (?, ?, ?, ?)
     ON CONFLICT (ledger_id, ym, fund_id) DO UPDATE SET amount = amount + excluded.amount`,
    ledgerId,
    ym,
    fundId,
    delta,
  );
  log.push([ym, fundId, delta]);
}

export function archiveFund(db: Db, ledgerId: number, userId: number, fundId: number, req: ArchiveRequest, today: string): { archiveId: number } {
  const currentYm = ymOf(today);
  const fund = activeFund(db, ledgerId, fundId, 'Фонд');
  if (fund.archived) throw new DomainError('Фонд уже в архиве.');
  if (fund.owner_user_id !== null) throw new DomainError('Это личный фонд участника. Сначала сними его в карточке участника.');
  const check = (id: number | null, what: string) => {
    if (id === null) return;
    if (id === fundId) throw new DomainError(`${what}: нужен другой фонд.`);
    if (activeFund(db, ledgerId, id, what).archived) throw new DomainError(`${what}: этот фонд тоже в архиве.`);
  };
  if (req.mode === 'move' && req.targetFundId === null) throw new DomainError('Выбери фонд, куда перенести операции.');
  check(req.targetFundId, 'Фонд для операций');
  check(req.balanceToFundId, 'Фонд для остатка');
  for (const a of req.assignments) check(a.fundId, 'Фонд для операции');

  const entries = all<{ id: number; date: string; amount: number; kind: string }>(
    db,
    'SELECT id, date, amount, kind FROM entries WHERE ledger_id = ? AND fund_id = ? AND inactive_at IS NULL AND auto_credit = 0',
    ledgerId,
    fundId,
  );
  const target = (entryId: number) => req.assignments.find((a) => a.entryId === entryId)?.fundId ?? req.targetFundId;
  const moving = req.mode === 'keep' ? [] : entries.filter((e) => target(e.id) !== null);
  if (req.mode === 'split' && moving.length < entries.length) throw new DomainError('Выбери фонд для каждой операции или фонд по умолчанию.');

  // Закрытые месяцы меняются только с согласием на пересчёт
  const planMonths = req.mode === 'move'
    ? all<{ ym: string }>(db, 'SELECT ym FROM plans WHERE ledger_id = ? AND fund_id = ? AND amount <> 0', ledgerId, fundId).map((p) => p.ym)
    : moving.map((e) => ymOf(e.date));
  if (!req.recalc && [...moving.map((e) => ymOf(e.date)), ...planMonths].some((ym) => isClosed(db, ledgerId, ym))) {
    throw new DomainError('Архивация меняет закрытые месяцы. Их итоги пересчитаются.', 409);
  }

  const entryMoves: [number, number, number][] = [];
  const planDeltas: PlanDelta[] = [];
  const openingDeltas: [number, number][] = [];

  for (const e of moving) {
    const to = target(e.id)!;
    const before = snapshot(db, 'entry', e.id);
    run(db, 'UPDATE entries SET fund_id = ? WHERE id = ?', to, e.id);
    entryMoves.push([e.id, fundId, to]);
    if (isClosed(db, ledgerId, ymOf(e.date))) logChange(db, ledgerId, userId, 'entry', e.id, 'update', before, snapshot(db, 'entry', e.id));
  }

  if (req.mode === 'move') {
    // Всё целиком: планы всех месяцев и стартовый остаток, тогда у архивного фонда ничего не остаётся
    for (const p of all<{ ym: string; amount: number }>(db, 'SELECT ym, amount FROM plans WHERE ledger_id = ? AND fund_id = ? AND amount <> 0', ledgerId, fundId)) {
      shiftPlan(db, ledgerId, p.ym, fundId, -p.amount, planDeltas);
      shiftPlan(db, ledgerId, p.ym, req.targetFundId!, p.amount, planDeltas);
    }
    if (fund.opening_balance) {
      run(db, 'UPDATE funds SET opening_balance = opening_balance + ? WHERE id = ?', fund.opening_balance, req.targetFundId);
      run(db, 'UPDATE funds SET opening_balance = 0 WHERE id = ?', fundId);
      openingDeltas.push([req.targetFundId!, fund.opening_balance], [fundId, -fund.opening_balance]);
    }
  } else if (req.mode === 'split') {
    // План месяца переезжает вслед за операциями, поэтому остатки фондов-получателей не меняются
    const byMonth = new Map<string, number>();
    for (const e of moving) {
      const key = `${ymOf(e.date)}|${target(e.id)}`;
      byMonth.set(key, (byMonth.get(key) ?? 0) + e.amount);
    }
    for (const [key, amount] of byMonth) {
      const [ym, to] = key.split('|');
      shiftPlan(db, ledgerId, ym, fundId, -amount, planDeltas);
      shiftPlan(db, ledgerId, ym, Number(to), amount, planDeltas);
    }
  }

  // План с текущего месяца вперёд снимается: фонд больше не копит
  for (const p of all<{ ym: string; amount: number }>(db, 'SELECT ym, amount FROM plans WHERE ledger_id = ? AND fund_id = ? AND ym >= ? AND amount <> 0', ledgerId, fundId, currentYm)) {
    shiftPlan(db, ledgerId, p.ym, fundId, -p.amount, planDeltas);
  }

  // Остаток уходит переносом текущего месяца; при минусе направление обратное
  let transferId: number | null = null;
  let lastYm = currentYm;
  const futureYm = get<{ ym: string | null }>(db, 'SELECT MAX(ym) ym FROM plans WHERE ledger_id = ?', ledgerId)?.ym;
  if (futureYm && futureYm > lastYm) lastYm = futureYm;
  const balance = fundBalance(db, ledgerId, fundId, lastYm);
  if (balance !== 0) {
    const other = req.mode === 'move' ? req.targetFundId : req.balanceToFundId;
    const [from, to] = balance > 0 ? [fundId, other] : [other, fundId];
    transferId = Number(
      run(
        db,
        'INSERT INTO fund_transfers (ledger_id, date, amount, from_fund_id, to_fund_id, comment, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ledgerId,
        today,
        Math.abs(balance),
        from,
        to,
        `Остаток фонда «${fund.name}» при архивации`,
        userId,
      ).lastInsertRowid,
    );
  }

  run(db, 'UPDATE funds SET archived = 1, pace_alert = 0 WHERE id = ?', fundId);
  const archiveId = Number(
    run(
      db,
      `INSERT INTO fund_archives (ledger_id, fund_id, mode, target_fund_id, balance_to_fund_id, entry_moves, plan_deltas, opening_deltas, transfer_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ledgerId,
      fundId,
      req.mode,
      req.targetFundId,
      req.balanceToFundId,
      JSON.stringify(entryMoves),
      JSON.stringify(planDeltas),
      JSON.stringify(openingDeltas),
      transferId,
      userId,
    ).lastInsertRowid,
  );
  if (transferId) run(db, 'UPDATE fund_transfers SET archive_id = ? WHERE id = ?', archiveId, transferId);
  return { archiveId };
}

/** Последняя неотменённая архивация фонда. */
export function lastArchive(db: Db, ledgerId: number, fundId: number) {
  return get<{ id: number; mode: ArchiveMode; target_fund_id: number | null; balance_to_fund_id: number | null; entry_moves: string; plan_deltas: string; opening_deltas: string; transfer_id: number | null; created_at: string }>(
    db,
    'SELECT * FROM fund_archives WHERE ledger_id = ? AND fund_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1',
    ledgerId,
    fundId,
  );
}

/**
 * Отмена архивации: операции возвращаются, если их не трогали после; планы и стартовые остатки меняются обратно
 * на ту же величину (поверх более поздних правок); перенос остатка снимается. Возвращает, сколько операций оставлено.
 */
export function restoreFund(db: Db, ledgerId: number, userId: number, fundId: number, recalc: boolean): { skipped: number } {
  const fund = activeFund(db, ledgerId, fundId, 'Фонд');
  if (!fund.archived) throw new DomainError('Фонд не в архиве.');
  const archive = lastArchive(db, ledgerId, fundId);
  if (!archive) {
    // Архивирован раньше, чем появилась отмена: просто снимаем отметку
    run(db, 'UPDATE funds SET archived = 0 WHERE id = ?', fundId);
    return { skipped: 0 };
  }
  const entryMoves = JSON.parse(archive.entry_moves) as [number, number, number][];
  const planDeltas = JSON.parse(archive.plan_deltas) as PlanDelta[];
  const openingDeltas = JSON.parse(archive.opening_deltas) as [number, number][];
  const transfer = archive.transfer_id ? get<{ date: string; inactive_at: string | null }>(db, 'SELECT date, inactive_at FROM fund_transfers WHERE id = ?', archive.transfer_id) : undefined;
  const entryDates = entryMoves.map(([id]) => get<{ date: string }>(db, 'SELECT date FROM entries WHERE id = ?', id)?.date).filter((d): d is string => !!d);
  const months = [...entryDates.map(ymOf), ...planDeltas.map(([ym]) => ym), ...(transfer && !transfer.inactive_at ? [ymOf(transfer.date)] : [])];
  if (!recalc && months.some((ym) => isClosed(db, ledgerId, ym))) throw new DomainError('Отмена архивации меняет закрытые месяцы. Их итоги пересчитаются.', 409);

  let skipped = 0;
  for (const [id, from, to] of entryMoves) {
    const row = get<{ date: string }>(db, 'SELECT date FROM entries WHERE id = ? AND fund_id = ? AND inactive_at IS NULL', id, to);
    if (!row) {
      skipped++;
      continue;
    }
    const before = snapshot(db, 'entry', id);
    run(db, 'UPDATE entries SET fund_id = ? WHERE id = ?', from, id);
    if (isClosed(db, ledgerId, ymOf(row.date))) logChange(db, ledgerId, userId, 'entry', id, 'update', before, snapshot(db, 'entry', id));
  }
  for (const [ym, fid, delta] of [...planDeltas].reverse()) {
    run(
      db,
      `INSERT INTO plans (ledger_id, ym, fund_id, amount) VALUES (?, ?, ?, ?)
       ON CONFLICT (ledger_id, ym, fund_id) DO UPDATE SET amount = amount + excluded.amount`,
      ledgerId,
      ym,
      fid,
      -delta,
    );
  }
  for (const [fid, delta] of openingDeltas) run(db, 'UPDATE funds SET opening_balance = opening_balance - ? WHERE id = ?', delta, fid);
  if (archive.transfer_id && transfer && !transfer.inactive_at) {
    const before = snapshot(db, 'transfer', archive.transfer_id);
    run(db, `UPDATE fund_transfers SET inactive_at = datetime('now') WHERE id = ?`, archive.transfer_id);
    if (isClosed(db, ledgerId, ymOf(transfer.date))) logChange(db, ledgerId, userId, 'transfer', archive.transfer_id, 'delete', before, null);
  }
  run(db, 'UPDATE funds SET archived = 0 WHERE id = ?', fundId);
  run(db, `UPDATE fund_archives SET undone_at = datetime('now') WHERE id = ?`, archive.id);
  return { skipped };
}

