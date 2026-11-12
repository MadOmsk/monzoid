import { all, get, run, type Db } from './db.js';
import { DomainError, isClosed, ymOf } from './domain.js';
import { normalizeTags, setAdjustmentTags, setEntryTags } from './tags.js';

const MAX_LISTED = 100;

export type ChangeKind = 'entry' | 'adjustment' | 'asset_value' | 'pot_move' | 'transfer';
export type ChangeAction = 'create' | 'update' | 'delete';

export interface EntryState {
  date: string;
  kind: string;
  amount: number;
  fundId: number | null;
  description: string;
  comment: string;
  paidBy: number | null;
  earnedBy: number | null;
  /** Актив, к которому относится расход; в старых записях журнала поля нет */
  potId?: number | null;
  /** Покупка, к которой привязан возврат. В снимке только если есть: так старые записи журнала совпадают с текущим состоянием */
  refundOf?: number;
  tags: string[];
}

/**
 * Меняет ли правка итоги или статистику: дата, вид, сумма, фонд, актив, кто платил, чей доход, теги.
 * Описание, комментарий и привязка возврата на расчёты не влияют, для них согласие на пересчёт закрытого месяца не нужно.
 */
export function affectsTotals(before: EntryState, after: EntryState): boolean {
  const key = (s: EntryState) => JSON.stringify([s.date, s.kind, s.amount, s.fundId, s.potId ?? null, s.paidBy, s.earnedBy, normalizeTags(s.tags).sort()]);
  return key(before) !== key(after);
}

interface AdjustmentState {
  date: string;
  amount: number;
  comment: string;
  tags: string[];
}

/** Оценка актива; сумма лежит в amount, как у остальных записей журнала */
interface AssetValueState {
  date: string;
  amount: number;
  comment: string;
  potId: number;
  tags: string[];
}

/** Сделка по вкладу: перевод, покупка или продажа */
interface PotMoveState {
  date: string;
  amount: number;
  units: number;
  comment: string;
  potId: number;
  tags: string[];
}

/** Перенос остатка; пустой фонд значит свободные */
interface TransferState {
  date: string;
  amount: number;
  comment: string;
  fromFundId: number | null;
  toFundId: number | null;
  tags: string[];
}

type State = EntryState | AdjustmentState | AssetValueState | PotMoveState | TransferState;

const TABLES: Record<ChangeKind, string> = { entry: 'entries', adjustment: 'adjustments', asset_value: 'asset_values', pot_move: 'pot_moves', transfer: 'fund_transfers' };

/** Изменение задевает закрытый месяц: тогда оно попадает в журнал, и его можно откатить. */
export function touchesClosed(db: Db, ledgerId: number, ...dates: string[]): boolean {
  return dates.some((date) => isClosed(db, ledgerId, ymOf(date)));
}

function tagNames(db: Db, table: 'entry_tags' | 'adjustment_tags', column: string, id: number): string[] {
  return all<{ name: string }>(db, `SELECT t.name FROM ${table} x JOIN tags t ON t.id = x.tag_id AND t.inactive_at IS NULL WHERE x.${column} = ? ORDER BY t.name`, id).map((t) => t.name);
}

/** Состояние записи; null, если её нет или она удалена. */
export function snapshot(db: Db, kind: ChangeKind, id: number): State | null {
  if (kind === 'entry') {
    const row = get<Omit<EntryState, 'tags' | 'refundOf'> & { refundOf: number | null }>(
      db,
      `SELECT date, kind, amount, fund_id fundId, description, comment, paid_by paidBy, earned_by earnedBy, pot_id potId, refund_of refundOf FROM entries WHERE id = ? AND inactive_at IS NULL`,
      id,
    );
    if (!row) return null;
    const { refundOf, ...rest } = row;
    return { ...rest, ...(refundOf ? { refundOf } : {}), tags: tagNames(db, 'entry_tags', 'entry_id', id) };
  }
  if (kind === 'transfer') {
    const row = get<Omit<TransferState, 'tags'>>(db, 'SELECT date, amount, comment, from_fund_id fromFundId, to_fund_id toFundId FROM fund_transfers WHERE id = ? AND inactive_at IS NULL', id);
    return row ? { ...row, tags: [] } : null;
  }
  if (kind === 'pot_move') {
    const row = get<Omit<PotMoveState, 'tags'>>(db, 'SELECT date, amount, units, comment, pot_id potId FROM pot_moves WHERE id = ? AND inactive_at IS NULL', id);
    return row ? { ...row, tags: [] } : null;
  }
  if (kind === 'asset_value') {
    const row = get<Omit<AssetValueState, 'tags'>>(db, 'SELECT date, value amount, comment, pot_id potId FROM asset_values WHERE id = ? AND inactive_at IS NULL', id);
    return row ? { ...row, tags: [] } : null;
  }
  const row = get<Omit<AdjustmentState, 'tags'>>(db, 'SELECT date, amount, comment FROM adjustments WHERE id = ? AND inactive_at IS NULL', id);
  return row ? { ...row, tags: tagNames(db, 'adjustment_tags', 'adjustment_id', id) } : null;
}

export function logChange(db: Db, ledgerId: number, userId: number, kind: ChangeKind, recordId: number, action: ChangeAction, before: State | null, after: State | null): void {
  run(
    db,
    'INSERT INTO closed_changes (ledger_id, user_id, kind, record_id, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ledgerId,
    userId,
    kind,
    recordId,
    action,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
  );
}

export function listChanges(db: Db, ledgerId: number) {
  return all<{ kind: ChangeKind; before: string | null; after: string | null; fundBefore: string | null; fundAfter: string | null }>(
    db,
    `SELECT c.id, c.kind, c.record_id recordId, c.action, c.before, c.after, c.created_at createdAt, c.reverted_at revertedAt,
       COALESCE(m.display_name, u.name) userName
     FROM closed_changes c LEFT JOIN members m ON m.ledger_id = c.ledger_id AND m.user_id = c.user_id LEFT JOIN users u ON u.id = c.user_id
     WHERE c.ledger_id = ? ORDER BY c.id DESC LIMIT ${MAX_LISTED}`,
    ledgerId,
  ).map((c) => {
    const before = c.before ? (JSON.parse(c.before) as State) : null;
    const after = c.after ? (JSON.parse(c.after) as State) : null;
    const fund = (state: State | null) => {
      // Для оценки актива на месте фонда показывается название актива
      // У операции potId есть всегда (актив сопутствующего расхода), поэтому сначала смотрим фонд
      // У переноса фонд «откуда», а если это свободные, то «куда»
      if (state && 'fromFundId' in state) {
        const name = (fid: number | null) => (fid ? get<{ name: string }>(db, 'SELECT name FROM funds WHERE id = ?', fid)?.name ?? '?' : 'Свободные');
        return `${name(state.fromFundId)} → ${name(state.toFundId)}`;
      }
      const id = state && 'fundId' in state ? state.fundId : null;
      if (!id && state && 'potId' in state && state.potId) return get<{ name: string }>(db, 'SELECT name FROM pots WHERE id = ?', state.potId)?.name ?? null;
      return id ? (get<{ name: string }>(db, 'SELECT name FROM funds WHERE id = ?', id)?.name ?? null) : null;
    };
    return { ...c, before, after, fundBefore: fund(before), fundAfter: fund(after) };
  });
}

function restore(db: Db, ledgerId: number, kind: ChangeKind, id: number, state: State): void {
  if (kind === 'entry') {
    const s = state as EntryState;
    run(
      db,
      'UPDATE entries SET date = ?, kind = ?, amount = ?, fund_id = ?, description = ?, comment = ?, paid_by = ?, earned_by = ?, pot_id = ?, refund_of = ?, inactive_at = NULL WHERE id = ?',
      s.date,
      s.kind,
      s.amount,
      s.fundId,
      s.description,
      s.comment,
      s.paidBy,
      s.earnedBy,
      s.potId ?? null,
      s.refundOf ?? null,
      id,
    );
    setEntryTags(db, ledgerId, id, s.tags);
  } else if (kind === 'transfer') {
    const s = state as TransferState;
    run(db, 'UPDATE fund_transfers SET date = ?, amount = ?, comment = ?, from_fund_id = ?, to_fund_id = ?, inactive_at = NULL WHERE id = ?', s.date, s.amount, s.comment, s.fromFundId, s.toFundId, id);
  } else if (kind === 'pot_move') {
    const s = state as PotMoveState;
    run(db, 'UPDATE pot_moves SET date = ?, amount = ?, units = ?, comment = ?, inactive_at = NULL WHERE id = ?', s.date, s.amount, s.units, s.comment, id);
  } else if (kind === 'asset_value') {
    const s = state as AssetValueState;
    run(db, 'UPDATE asset_values SET date = ?, value = ?, comment = ?, inactive_at = NULL WHERE id = ?', s.date, s.amount, s.comment, id);
  } else {
    const s = state as AdjustmentState;
    run(db, 'UPDATE adjustments SET date = ?, amount = ?, comment = ?, inactive_at = NULL WHERE id = ?', s.date, s.amount, s.comment, id);
    setAdjustmentTags(db, ledgerId, id, s.tags);
  }
}

/** Возвращает запись к состоянию до изменения. Если её меняли позже, сначала нужно откатить более позднее изменение. */
export function revertChange(db: Db, ledgerId: number, userId: number, changeId: number): void {
  const change = get<{ kind: ChangeKind; record_id: number; action: ChangeAction; before: string | null; after: string | null; reverted_at: string | null }>(
    db,
    'SELECT kind, record_id, action, before, after, reverted_at FROM closed_changes WHERE id = ? AND ledger_id = ?',
    changeId,
    ledgerId,
  );
  if (!change) throw new DomainError('Изменение не найдено', 404);
  if (change.reverted_at) throw new DomainError('Это изменение уже откачено.');
  const current = snapshot(db, change.kind, change.record_id);
  if (JSON.stringify(current) !== (change.after ?? 'null')) {
    throw new DomainError('Запись менялась после этого. Сначала откати более позднее изменение.');
  }
  const table = TABLES[change.kind];
  if (change.before) restore(db, ledgerId, change.kind, change.record_id, JSON.parse(change.before));
  else run(db, `UPDATE ${table} SET inactive_at = datetime('now') WHERE id = ?`, change.record_id);
  run(db, `UPDATE closed_changes SET reverted_at = datetime('now'), reverted_by = ? WHERE id = ?`, userId, changeId);
}
