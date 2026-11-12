import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function setting(db: Db, key: string): string | null {
  return get<{ value: string }>(db, 'SELECT value FROM app_settings WHERE key = ?', key)?.value ?? null;
}

function setSetting(db: Db, key: string, value: string): void {
  run(db, 'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
}

/** По умолчанию отправка включена, раз в неделю */
export function backupSettings(db: Db): BackupSettings {
  return {
    enabled: setting(db, 'backup_send_enabled') !== '0',
    days: Number(setting(db, 'backup_send_days') ?? 7),
    lastSentAt: setting(db, 'backup_last_sent_at'),
  };
}

export function updateBackupSettings(db: Db, patch: { enabled?: boolean; days?: number }): BackupSettings {
  if (patch.enabled !== undefined) setSetting(db, 'backup_send_enabled', patch.enabled ? '1' : '0');
  if (patch.days !== undefined) setSetting(db, 'backup_send_days', String(patch.days));
  return backupSettings(db);
}

/** Целостная копия всей базы (все учёты сервиса) в gzip, владельцам сервиса в личку */
export async function sendBackup(db: Db, send: DocumentSender, ownerIds: number[], now = new Date()): Promise<number> {
  if (!ownerIds.length) throw new Error('Не заданы владельцы сервиса (OWNER_TELEGRAM_IDS).');
  const dir = mkdtempSync(join(tmpdir(), 'monzoid-backup-'));
  try {
    const path = join(dir, 'copy.db');
    db.prepare('VACUUM INTO ?').run(path);
    const file = gzipSync(readFileSync(path));
    const day = now.toISOString().slice(0, 10);
    const ledgers = all<{ n: number }>(db, 'SELECT COUNT(*) n FROM ledgers')[0].n;
    for (const chatId of ownerIds) {
      await send(chatId, file, `monzoid-${day}.db.gz`, `Monzoid: копия базы на ${day} (учётов: ${ledgers}). Храни у себя и не пересылай: в ней весь учёт.`);
    }
    setSetting(db, 'backup_last_sent_at', now.toISOString());
    return ownerIds.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Пора ли отправлять: первая отправка через полный интервал после включения функции */
export function backupDue(db: Db, now = new Date()): boolean {
  const s = backupSettings(db);
  if (!s.enabled) return false;
  if (!s.lastSentAt) {
    setSetting(db, 'backup_last_sent_at', now.toISOString());
    return false;
  }
  return now.getTime() - Date.parse(s.lastSentAt) >= s.days * DAY_MS - 60_000;
}

/** Проверка раз в час; ошибки отправки только в лог, следующая попытка через час */
export function startBackupSender(db: Db, send: DocumentSender, ownerIds: number[]): void {
  const tick = async () => {
    try {
      if (backupDue(db)) console.log(`Копия базы отправлена в Telegram: ${await sendBackup(db, send, ownerIds)}`);
    } catch (e) {
      console.error('Копия базы в Telegram не отправлена:', (e as Error).message);
    }
  };
  setInterval(tick, 3_600_000).unref();
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
