import { all, get, run, tx, type Db } from './db.js';
import { DomainError } from './domain.js';
import { createImportFromRows } from './imports.js';
import type { MarketSource } from './market.js';
import type { FundSuggester } from './statements/ai.js';
import type { ParsedStatement, StatementRow } from './statements/parse.js';

/**
 * Очередь выписок, присланных боту. Файл не хранится: при получении он сразу разбирается, в очередь идут операции.
 * Пока база не выбрана (у человека их несколько), ledger_id пустой. Обработка в приложении создаёт обычную выписку на проверку.
 */

const BANK_NAMES: Record<string, string> = { kaspi: 'Kaspi Gold', freedom: 'Freedom Bank' };

export interface QueuedStatement {
  id: number;
  ledgerId: number | null;
  userId: number;
  fileName: string;
  bank: string;
  account: string;
  dateFrom: string | null;
  dateTo: string | null;
  count: number;
  createdAt: string;
}

const COLUMNS = `id, ledger_id ledgerId, user_id userId, file_name fileName, bank, account, date_from dateFrom, date_to dateTo, row_count count, created_at createdAt`;

export function enqueueStatement(db: Db, userId: number, fileName: string, parsed: ParsedStatement, ledgerId: number | null): QueuedStatement {
  const dates = parsed.rows.map((r) => r.date).sort();
  const id = Number(
    run(
      db,
      'INSERT INTO statement_queue (user_id, ledger_id, file_name, bank, account, date_from, date_to, row_count, rows, warnings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      userId,
      ledgerId,
      fileName,
      parsed.bank,
      parsed.account,
      dates[0] ?? null,
      dates.at(-1) ?? null,
      parsed.rows.length,
      JSON.stringify(parsed.rows),
      JSON.stringify(parsed.warnings),
    ).lastInsertRowid,
  );
  return queued(db, id)!;
}

export function queued(db: Db, id: number): QueuedStatement | undefined {
  return get<QueuedStatement>(db, `SELECT ${COLUMNS} FROM statement_queue WHERE id = ? AND processed_at IS NULL AND inactive_at IS NULL`, id);
}

export function assignLedger(db: Db, id: number, ledgerId: number): void {
  run(db, 'UPDATE statement_queue SET ledger_id = ? WHERE id = ? AND processed_at IS NULL AND inactive_at IS NULL', ledgerId, id);
}

/** Ожидающие обработки выписки базы. Участник видит свои, админ все. */
export function listQueue(db: Db, ledgerId: number, userId: number, isAdmin: boolean): (QueuedStatement & { userName: string | null })[] {
  return all(
    db,
    `SELECT q.id, q.ledger_id ledgerId, q.user_id userId, q.file_name fileName, q.bank, q.account, q.date_from dateFrom, q.date_to dateTo, q.row_count count, q.created_at createdAt,
       m.display_name userName
     FROM statement_queue q LEFT JOIN members m ON m.ledger_id = q.ledger_id AND m.user_id = q.user_id
     WHERE q.ledger_id = ? AND q.processed_at IS NULL AND q.inactive_at IS NULL AND (? OR q.user_id = ?) ORDER BY q.id`,
    ledgerId,
    isAdmin ? 1 : 0,
    userId,
  );
}

export function removeQueued(db: Db, ledgerId: number, id: number, userId: number, isAdmin: boolean): void {
  const item = get<{ user_id: number }>(db, 'SELECT user_id FROM statement_queue WHERE id = ? AND ledger_id = ? AND processed_at IS NULL AND inactive_at IS NULL', id, ledgerId);
  if (!item) throw new DomainError('Выписки нет в очереди', 404);
  if (!isAdmin && item.user_id !== userId) throw new DomainError('Это выписка другого участника', 403);
  run(db, `UPDATE statement_queue SET inactive_at = datetime('now'), rows = '[]' WHERE id = ?`, id);
}

/** Все выписки очереди, видимые человеку, разбираются одной выпиской: так находятся переводы между своими картами. */
export async function processQueue(db: Db, suggestFunds: FundSuggester, ledgerId: number, userId: number, isAdmin: boolean, market?: MarketSource): Promise<number> {
  const items = all<{ id: number; file_name: string; rows: string; warnings: string }>(
    db,
    'SELECT id, file_name, rows, warnings FROM statement_queue WHERE ledger_id = ? AND processed_at IS NULL AND inactive_at IS NULL AND (? OR user_id = ?) ORDER BY id',
    ledgerId,
    isAdmin ? 1 : 0,
    userId,
  );
  if (!items.length) throw new DomainError('В очереди нет выписок.');
  const rows: StatementRow[] = items.flatMap((i) => JSON.parse(i.rows));
  const warnings: string[] = items.flatMap((i) => (JSON.parse(i.warnings) as string[]).map((w) => `${i.file_name}: ${w}`));
  const batchId = await createImportFromRows(db, suggestFunds, ledgerId, userId, items.map((i) => i.file_name), rows, warnings, market);
  tx(db, () => {
    for (const i of items) run(db, `UPDATE statement_queue SET processed_at = datetime('now'), batch_id = ?, rows = '[]' WHERE id = ?`, batchId, i.id);
  });
  return batchId;
}

function day(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** «Kaspi Gold по карте *1234 за 01.10.2026–31.10.2026» */
export function describe(item: Pick<QueuedStatement, 'bank' | 'account' | 'dateFrom' | 'dateTo'>): string {
  const bank = BANK_NAMES[item.bank] ?? item.bank;
  const card = item.account ? ` по карте *${item.account}` : '';
  const period = !item.dateFrom ? ' без операций' : item.dateFrom === item.dateTo ? ` за ${day(item.dateFrom)}` : ` за ${day(item.dateFrom)}–${day(item.dateTo!)}`;
  return `${bank}${card}${period}`;
}
