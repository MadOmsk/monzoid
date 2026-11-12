import { get, type Db } from './db.js';
import { DomainError, hiddenFundIds } from './domain.js';

// Возврат с привязкой: entries.refund_of указывает на покупку. На суммы связь не влияет (возврат и так расход с минусом),
// она показывает, что покупка возвращена полностью или частично, и не даёт вернуть больше, чем куплено

export interface Viewer {
  ledgerId: number;
  userId: number;
  isAdmin: boolean;
}

function moneyText(db: Db, ledgerId: number, tiyn: number): string {
  const { currency } = get<{ currency: string }>(db, 'SELECT currency FROM ledgers WHERE id = ?', ledgerId)!;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(tiyn / 100)} ${currency}`;
}

/** Сколько уже вернули по покупке, не считая возврата exceptId. */
export function refundedSum(db: Db, originalId: number, exceptId: number | null = null): number {
  return get<{ s: number }>(db, 'SELECT COALESCE(-SUM(amount), 0) s FROM entries WHERE refund_of = ? AND inactive_at IS NULL AND id IS NOT ?', originalId, exceptId)!.s;
}

/** Возврат привязывается только к видимой покупке этой базы и не может вернуть больше, чем по ней осталось. */
export function checkRefund(db: Db, ctx: Viewer, entryId: number | null, refundOf: number | null, kind: string, amount: number): void {
  if (refundOf === null) return;
  if (kind !== 'expense' || amount >= 0) throw new DomainError('Привязать к покупке можно только возврат.');
  const original = get<{ amount: number; fund_id: number | null }>(
    db,
    `SELECT amount, fund_id FROM entries WHERE id = ? AND ledger_id = ? AND kind = 'expense' AND auto_credit = 0 AND inactive_at IS NULL`,
    refundOf,
    ctx.ledgerId,
  );
  if (!original || original.amount <= 0 || refundOf === entryId || (original.fund_id && hiddenFundIds(db, ctx.ledgerId, ctx.userId, ctx.isAdmin).has(original.fund_id))) {
    throw new DomainError('Покупка для возврата не найдена', 404);
  }
  const others = refundedSum(db, refundOf, entryId);
  if (others - amount > original.amount) throw new DomainError(`Возврат больше покупки: по ней осталось вернуть ${moneyText(db, ctx.ledgerId, original.amount - others)}.`);
}

/** Покупку с привязанными возвратами нельзя сделать меньше возвращённого или превратить в доход. */
export function checkRefunded(db: Db, ledgerId: number, entryId: number, kind: string, amount: number): void {
  const refunded = refundedSum(db, entryId);
  if (refunded > 0 && (kind !== 'expense' || amount < refunded)) {
    throw new DomainError(`К покупке привязаны возвраты на ${moneyText(db, ledgerId, refunded)}: сумма не может быть меньше.`);
  }
}
