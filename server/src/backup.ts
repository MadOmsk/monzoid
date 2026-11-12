import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { all, get, run, type Db } from './db.js';

/** Отправка файла в Telegram: в тестах подменяется */
export type DocumentSender = (chatId: number, file: Buffer, fileName: string, caption: string) => Promise<void>;

export const BACKUP_INTERVALS = [1, 3, 7, 14, 30] as const;
const DAY_MS = 86_400_000;

export interface BackupSettings {
  enabled: boolean;
  days: number;
  lastSentAt: string | null;
}

/** Настройки копии у каждой базы свои; по умолчанию включено, раз в неделю */
export function backupSettings(db: Db, ledgerId: number): BackupSettings {
  const row = get<{ backup_enabled: number; backup_days: number; backup_last_sent_at: string | null }>(
    db,
    'SELECT backup_enabled, backup_days, backup_last_sent_at FROM ledgers WHERE id = ?',
    ledgerId,
  )!;
  return { enabled: !!row.backup_enabled, days: row.backup_days, lastSentAt: row.backup_last_sent_at };
}

export function updateBackupSettings(db: Db, ledgerId: number, patch: { enabled?: boolean; days?: number }): BackupSettings {
  if (patch.enabled !== undefined) run(db, 'UPDATE ledgers SET backup_enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, ledgerId);
  if (patch.days !== undefined) run(db, 'UPDATE ledgers SET backup_days = ? WHERE id = ?', patch.days, ledgerId);
  return backupSettings(db, ledgerId);
}

/**
 * Копия одной базы: файл SQLite той же схемы, в котором остались только её данные.
 * Чужие базы, их участники и общие таблицы сервиса удаляются, затем VACUUM, чтобы удалённое не осталось в свободных страницах.
 */
export function ledgerCopy(db: Db, ledgerId: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'monzoid-backup-'));
  try {
    const path = join(dir, 'copy.db');
    db.prepare('VACUUM INTO ?').run(path);
    const copy = new DatabaseSync(path);
    try {
      copy.exec('PRAGMA foreign_keys = OFF');
      const tables = (copy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
      const columns = (t: string) => (copy.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
      copy.exec('BEGIN');
      copy.prepare('DELETE FROM ledgers WHERE id != ?').run(ledgerId);
      for (const t of tables) if (t !== 'ledgers' && columns(t).includes('ledger_id')) copy.prepare(`DELETE FROM "${t}" WHERE ledger_id IS NOT ?`).run(ledgerId);
      // Данные, привязанные к вкладам, записям и тегам других баз
      for (const t of tables) {
        const cols = columns(t);
        if (cols.includes('pot_id') && t !== 'pots') copy.exec(`DELETE FROM "${t}" WHERE pot_id IS NOT NULL AND pot_id NOT IN (SELECT id FROM pots)`);
        if (cols.includes('entry_id')) copy.exec(`DELETE FROM "${t}" WHERE entry_id NOT IN (SELECT id FROM entries)`);
        if (cols.includes('adjustment_id')) copy.exec(`DELETE FROM "${t}" WHERE adjustment_id NOT IN (SELECT id FROM adjustments)`);
      }
      // Люди: только участники этой базы (и бывшие, у кого остался профиль)
      if (tables.includes('users')) {
        copy.exec(`DELETE FROM users WHERE id NOT IN (SELECT user_id FROM members UNION SELECT former_user_id FROM members WHERE former_user_id IS NOT NULL)`);
      }
      for (const t of ['service_invites', 'app_settings']) if (tables.includes(t)) copy.exec(`DELETE FROM "${t}"`);
      copy.exec('COMMIT');
      copy.exec('VACUUM');
    } finally {
      copy.close();
    }
    return gzipSync(readFileSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Администраторы базы с аккаунтом Telegram (у виртуальных участников ID отрицательный) */
export function backupRecipients(db: Db, ledgerId: number): number[] {
  return all<{ user_id: number }>(db, `SELECT user_id FROM members WHERE ledger_id = ? AND role = 'admin' AND inactive_at IS NULL AND user_id > 0`, ledgerId).map((m) => m.user_id);
}

/** Копия базы получателям; отметка времени ставится, если ушла хотя бы одному */
export async function sendBackup(db: Db, send: DocumentSender, ledgerId: number, recipients: number[], now = new Date()): Promise<number> {
  if (!recipients.length) throw new Error('В базе нет администраторов с аккаунтом Telegram.');
  const { name } = get<{ name: string }>(db, 'SELECT name FROM ledgers WHERE id = ?', ledgerId)!;
  const file = ledgerCopy(db, ledgerId);
  const day = now.toISOString().slice(0, 10);
  const slug = name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || `baza-${ledgerId}`;
  let sent = 0;
  const errors: string[] = [];
  for (const chatId of recipients) {
    try {
      await send(chatId, file, `monzoid-${slug}-${day}.db.gz`, `Monzoid: копия базы «${name}» на ${day}. Храни у себя и не пересылай: в ней весь учёт этой базы.`);
      sent++;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (!sent) throw new Error(errors[0] ?? 'не отправлено');
  run(db, 'UPDATE ledgers SET backup_last_sent_at = ? WHERE id = ?', now.toISOString(), ledgerId);
  return sent;
}

/** Базы, которым пора отправить копию. Первая отправка через полный интервал после включения функции */
export function dueLedgers(db: Db, now = new Date()): number[] {
  const due: number[] = [];
  for (const l of all<{ id: number; backup_days: number; backup_last_sent_at: string | null }>(db, 'SELECT id, backup_days, backup_last_sent_at FROM ledgers WHERE backup_enabled = 1')) {
    if (!l.backup_last_sent_at) {
      run(db, 'UPDATE ledgers SET backup_last_sent_at = ? WHERE id = ?', now.toISOString(), l.id);
      continue;
    }
    if (now.getTime() - Date.parse(l.backup_last_sent_at) >= l.backup_days * DAY_MS - 60_000) due.push(l.id);
  }
  return due;
}

/** Проверка раз в час; ошибки только в лог, следующая попытка через час */
export function startBackupSender(db: Db, send: DocumentSender): void {
  const tick = async () => {
    for (const ledgerId of dueLedgers(db)) {
      try {
        const sent = await sendBackup(db, send, ledgerId, backupRecipients(db, ledgerId));
        console.log(`Копия базы ${ledgerId} отправлена в Telegram: ${sent}`);
      } catch (e) {
        console.error(`Копия базы ${ledgerId} не отправлена:`, (e as Error).message);
      }
    }
  };
  setInterval(() => void tick(), 3_600_000).unref();
  void tick();
}

export function telegramDocumentSender(token: string): DocumentSender {
  return async (chatId, file, fileName, caption) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('document', new Blob([new Uint8Array(file)], { type: 'application/gzip' }), fileName);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(`Telegram не принял файл: ${data.description ?? res.status}`);
  };
}
