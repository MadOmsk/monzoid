// Целостная копия базы без остановки приложения.
// Когда копии вместе превышают лимит, удаляются самые старые; самая новая остаётся всегда.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_TOTAL_BYTES = Number(process.env.BACKUP_MAX_BYTES ?? 128 * 1024 * 1024);
const dbPath = process.env.DB_PATH;
const dir = process.env.BACKUP_DIR;
if (!dbPath || !dir) throw new Error('Нужны DB_PATH и BACKUP_DIR');

mkdirSync(dir, { recursive: true });
const target = join(dir, `monzoid-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(dbPath);
db.prepare('VACUUM INTO ?').run(target);
db.close();

const copies = readdirSync(dir)
  .filter((f) => f.startsWith('monzoid-') && f.endsWith('.db'))
  .sort()
  .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }));
let total = copies.reduce((sum, c) => sum + c.size, 0);
for (const old of copies.slice(0, -1)) {
  if (total <= MAX_TOTAL_BYTES) break;
  rmSync(old.path);
  total -= old.size;
}
console.log(`Копия: ${target}. Всего копий: ${total} байт из ${MAX_TOTAL_BYTES}`);

