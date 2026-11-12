import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fillFundEmojis, moveMemberEmojis } from './emoji.js';
import { assignPersonalFunds } from './members.js';

// Все суммы хранятся в сотых долях основной валюты базы (целое число): 1 тенге = 100 тиынов.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledgers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_ym TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS members (
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  display_name TEXT NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
-- Одноразовое приглашение в сервис: даёт право создать свою базу, но не доступ к чужой.
CREATE TABLE IF NOT EXISTS service_invites (
  token TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS funds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  opening_balance INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ledger_id, name)
);
CREATE TABLE IF NOT EXISTS plans (
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  ym TEXT NOT NULL,
  fund_id INTEGER NOT NULL REFERENCES funds(id),
  amount INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, ym, fund_id)
);
CREATE TABLE IF NOT EXISTS closed_months (
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  ym TEXT NOT NULL,
  closed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ledger_id, ym)
);
-- kind=expense: amount > 0 расход, amount < 0 возврат. kind=income: amount > 0, без фонда.
-- paid_by: участник, потративший свои деньги; NULL значит общие деньги базы.
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  amount INTEGER NOT NULL,
  fund_id INTEGER REFERENCES funds(id),
  description TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  paid_by INTEGER REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  import_row_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((kind = 'expense' AND fund_id IS NOT NULL) OR (kind = 'income' AND fund_id IS NULL AND amount > 0))
);
CREATE INDEX IF NOT EXISTS entries_ledger_date ON entries (ledger_id, date);
-- Выплата участнику: уменьшает долг базы перед ним, на свободные средства не влияет.
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  comment TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  import_row_id INTEGER
);
-- Ручная корректировка свободных средств.
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT ''
);
-- Копилки вне фондов: вклады, валюта.
CREATE TABLE IF NOT EXISTS pots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KZT',
  opening_balance INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ledger_id, name)
);
-- amount > 0: из свободных средств в копилку, amount < 0: обратно. foreign_amount только для справки.
CREATE TABLE IF NOT EXISTS pot_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pot_id INTEGER NOT NULL REFERENCES pots(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  foreign_amount INTEGER,
  comment TEXT NOT NULL DEFAULT ''
);
-- Теги не влияют на суммы. Названия хранятся в нижнем регистре, чтобы «Дети» и «дети» были одним тегом.
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE (ledger_id, name)
);
CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);
CREATE INDEX IF NOT EXISTS entry_tags_tag ON entry_tags (tag_id);
CREATE TABLE IF NOT EXISTS adjustment_tags (
  adjustment_id INTEGER NOT NULL REFERENCES adjustments(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (adjustment_id, tag_id)
);
CREATE INDEX IF NOT EXISTS adjustment_tags_tag ON adjustment_tags (tag_id);
-- Выписки, присланные боту: разобранные операции ждут, пока человек нажмёт «Обработать» в приложении. Файл не хранится.
-- ledger_id пустой, пока человек не выбрал базу в боте.
CREATE TABLE IF NOT EXISTS statement_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ledger_id INTEGER REFERENCES ledgers(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  bank TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  date_from TEXT,
  date_to TEXT,
  row_count INTEGER NOT NULL,
  rows TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  batch_id INTEGER,
  inactive_at TEXT
);
-- Изменения закрытых месяцев с пересчётом: состояние до и после, чтобы можно было откатить.
CREATE TABLE IF NOT EXISTS closed_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  before TEXT,
  after TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reverted_at TEXT,
  reverted_by INTEGER
);
-- Последние известные курсы и котировки, общие для всех баз.
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT PRIMARY KEY,
  per_usd REAL NOT NULL,
  date TEXT NOT NULL
);
-- Настройки всего сервиса (не отдельной базы): ключ и значение
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  ticker TEXT PRIMARY KEY,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  date TEXT NOT NULL
);
-- Официальные курсы Нацбанка РК на дату, в тенге за единицу. Строка KZT отмечает, что дата уже загружена.
CREATE TABLE IF NOT EXISTS fx_history (
  date TEXT NOT NULL,
  currency TEXT NOT NULL,
  kzt_per_unit REAL NOT NULL,
  PRIMARY KEY (date, currency)
);
-- Оценки активов (недвижимость, машины) вручную. Новая оценка не заменяет старую: история стоимости сохраняется.
CREATE TABLE IF NOT EXISTS asset_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pot_id INTEGER NOT NULL REFERENCES pots(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  inactive_at TEXT
);
-- Цена единицы вклада за месяц. Обновляется каждый день, а по окончании месяца остаётся ценой на его конец.
CREATE TABLE IF NOT EXISTS pot_prices (
  pot_id INTEGER NOT NULL REFERENCES pots(id) ON DELETE CASCADE,
  ym TEXT NOT NULL,
  unit_value REAL NOT NULL,
  PRIMARY KEY (pot_id, ym)
);
-- Цена единицы вклада по дням: для изменения за день
CREATE TABLE IF NOT EXISTS pot_day_prices (
  pot_id INTEGER NOT NULL REFERENCES pots(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  unit_value REAL NOT NULL,
  PRIMARY KEY (pot_id, date)
);
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  files TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Хеш строки живёт дольше решения по ней: так повторная выписка не поднимает уже разобранное.
CREATE TABLE IF NOT EXISTS import_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  bank TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  op TEXT NOT NULL,
  details TEXT NOT NULL,
  merchant_key TEXT NOT NULL,
  suggested_action TEXT NOT NULL,
  suggested_fund_id INTEGER,
  suggested_user_id INTEGER,
  suggestion_source TEXT NOT NULL DEFAULT 'none',
  hint TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'posted', 'skipped')),
  UNIQUE (ledger_id, hash)
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const columns = all<{ name: string }>(db, 'PRAGMA table_info(import_rows)');
  if (!columns.some((c) => c.name === 'is_pending')) {
    db.exec('ALTER TABLE import_rows ADD COLUMN is_pending INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some((c) => c.name === 'suggested_tags')) {
    db.exec(`ALTER TABLE import_rows ADD COLUMN suggested_tags TEXT NOT NULL DEFAULT '[]'`);
  }
  // Записи не удаляются: неактивная запись хранит время отметки и не участвует в расчётах
  for (const table of ['entries', 'settlements', 'adjustments', 'members', 'tags']) {
    if (!all<{ name: string }>(db, `PRAGMA table_info(${table})`).some((c) => c.name === 'inactive_at')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN inactive_at TEXT`);
    }
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(funds)').some((c) => c.name === 'credit_user_id')) {
    db.exec('ALTER TABLE funds ADD COLUMN credit_user_id INTEGER');
    db.exec('ALTER TABLE funds ADD COLUMN credit_from TEXT');
    db.exec('ALTER TABLE entries ADD COLUMN auto_credit INTEGER NOT NULL DEFAULT 0');
  }
  const userColumns = all<{ name: string }>(db, 'PRAGMA table_info(users)');
  if (!userColumns.some((c) => c.name === 'username')) {
    db.exec('ALTER TABLE users ADD COLUMN username TEXT');
  }
  const inviteColumns = all<{ name: string }>(db, 'PRAGMA table_info(invites)');
  if (!inviteColumns.some((c) => c.name === 'virtual_user_id')) {
    db.exec('ALTER TABLE invites ADD COLUMN virtual_user_id INTEGER');
  }
  const entryColumns = all<{ name: string }>(db, 'PRAGMA table_info(entries)');
  if (!entryColumns.some((c) => c.name === 'earned_by')) {
    db.exec('ALTER TABLE entries ADD COLUMN earned_by INTEGER REFERENCES users(id)');
  }
  // Возврат с привязкой: к какой покупке он относится. Суммы не меняет, только показывает, что покупка возвращена
  if (!entryColumns.some((c) => c.name === 'refund_of')) {
    db.exec('ALTER TABLE entries ADD COLUMN refund_of INTEGER REFERENCES entries(id)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS entries_refund_of ON entries (refund_of) WHERE refund_of IS NOT NULL');
  // Дата последнего расчёта с участником: просто отметка для людей, на суммы не влияет
  if (!all<{ name: string }>(db, 'PRAGMA table_info(members)').some((c) => c.name === 'settled_until')) {
    db.exec('ALTER TABLE members ADD COLUMN settled_until TEXT');
  }
  // Уведомления в Telegram: человек может их выключить
  if (!all<{ name: string }>(db, 'PRAGMA table_info(users)').some((c) => c.name === 'notify')) {
    db.exec('ALTER TABLE users ADD COLUMN notify INTEGER NOT NULL DEFAULT 1');
  }
  // Очередь уведомлений: выплаты уходят сразу, операции пакетом после 10 минут тишины
  db.exec(`CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    actor_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // Запланированные платежи с напоминанием. В учёт не входят, пока человек не подтвердит операцию.
  // status: scheduled (ждёт напоминания), due (напомнили, ждёт подтверждения), done (стала операцией entry_id)
  db.exec(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    comment TEXT NOT NULL,
    amount INTEGER,
    fund_id INTEGER REFERENCES funds(id),
    due_date TEXT NOT NULL,
    remind_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    entry_id INTEGER,
    inactive_at TEXT
  )`);
  // Повтор платежа: week или month. Активна одна запись серии; после подтверждения или пропуска появляется следующая.
  // series_due: плановая дата этого раза (перенос её не меняет), remind_offset: напоминание относительно полуночи UTC даты оплаты,
  // anchor_day: число месяца, чтобы 31-е не съезжало на 28-е навсегда
  if (!all<{ name: string }>(db, 'PRAGMA table_info(reminders)').some((c) => c.name === 'repeat')) {
    db.exec('ALTER TABLE reminders ADD COLUMN repeat TEXT');
    db.exec('ALTER TABLE reminders ADD COLUMN series_due TEXT');
    db.exec('ALTER TABLE reminders ADD COLUMN remind_offset INTEGER');
    db.exec('ALTER TABLE reminders ADD COLUMN anchor_day INTEGER');
  }
  // Время оплаты (ЧЧ:ММ по часам человека): от него считается «напомнить за …»
  if (!all<{ name: string }>(db, 'PRAGMA table_info(reminders)').some((c) => c.name === 'due_time')) {
    db.exec('ALTER TABLE reminders ADD COLUMN due_time TEXT');
  }
  // Перенос остатка: из фонда в фонд, из фонда в свободные или обратно (NULL = свободные). «Деньги» не меняет,
  // план и траты фондов тоже: меняются только остатки. archive_id: перенос сделала архивация фонда
  db.exec(`CREATE TABLE IF NOT EXISTS fund_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    from_fund_id INTEGER REFERENCES funds(id),
    to_fund_id INTEGER REFERENCES funds(id),
    comment TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    inactive_at TEXT,
    archive_id INTEGER
  )`);
  // Архивация фонда и всё, что она сделала: по этой записи она отменяется.
  // entry_moves: [id, из фонда, в фонд]; plan_deltas: [ym, фонд, изменение]; opening_deltas: [фонд, изменение]
  db.exec(`CREATE TABLE IF NOT EXISTS fund_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    fund_id INTEGER NOT NULL REFERENCES funds(id),
    mode TEXT NOT NULL,
    target_fund_id INTEGER,
    balance_to_fund_id INTEGER,
    entry_moves TEXT NOT NULL DEFAULT '[]',
    plan_deltas TEXT NOT NULL DEFAULT '[]',
    opening_deltas TEXT NOT NULL DEFAULT '[]',
    transfer_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    undone_at TEXT
  )`);
  // Галочка участника: его личный фонд видят только он и администраторы
  if (!all<{ name: string }>(db, 'PRAGMA table_info(members)').some((c) => c.name === 'hide_personal')) {
    db.exec('ALTER TABLE members ADD COLUMN hide_personal INTEGER NOT NULL DEFAULT 0');
  }
  // Уведомления по одной базе: участник может выключить их только здесь, не трогая остальные базы
  if (!all<{ name: string }>(db, 'PRAGMA table_info(members)').some((c) => c.name === 'notify')) {
    db.exec('ALTER TABLE members ADD COLUMN notify INTEGER NOT NULL DEFAULT 1');
  }
  // Вышедший участник остаётся профилем без аккаунта; здесь помнится, чей он был, чтобы при возвращении прицепиться к нему
  if (!all<{ name: string }>(db, 'PRAGMA table_info(members)').some((c) => c.name === 'former_user_id')) {
    db.exec('ALTER TABLE members ADD COLUMN former_user_id INTEGER');
  }
  const ledgerColumns = all<{ name: string }>(db, 'PRAGMA table_info(ledgers)');
  if (!ledgerColumns.some((c) => c.name === 'currency')) {
    db.exec(`ALTER TABLE ledgers ADD COLUMN currency TEXT NOT NULL DEFAULT 'KZT'`);
  }
  if (!ledgerColumns.some((c) => c.name === 'locked')) {
    db.exec('ALTER TABLE ledgers ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
    // Пустая тема: цвета Telegram
    db.exec(`ALTER TABLE ledgers ADD COLUMN theme TEXT NOT NULL DEFAULT ''`);
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(ledgers)').some((c) => c.name === 'design')) {
    // Дизайн (формы, шрифт) отделён от цветовой схемы; кто выбрал тему Unlocked, получает и её дизайн
    db.exec(`ALTER TABLE ledgers ADD COLUMN design TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE ledgers SET design = 'unlocked' WHERE theme = 'unlocked'`);
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(users)').some((c) => c.name === 'theme')) {
    // Оформление перешло от базы к человеку: берётся из его последней незаблокированной базы с выбранным оформлением.
    // Колонки theme и design у ledgers остаются, но больше не читаются.
    db.exec(`ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE users ADD COLUMN design TEXT NOT NULL DEFAULT ''`);
    const source = `FROM members m JOIN ledgers l ON l.id = m.ledger_id
      WHERE m.user_id = users.id AND m.inactive_at IS NULL AND l.locked = 0 AND (l.theme <> '' OR l.design <> '') ORDER BY l.id DESC LIMIT 1`;
    db.exec(`UPDATE users SET theme = COALESCE((SELECT l.theme ${source}), ''), design = COALESCE((SELECT l.design ${source}), '')`);
  }
  // Дневная (theme) и ночная (theme_night) схемы и режим: system по устройству, day, night.
  // Прежний выбор сохраняется: ночная схема переезжает в ночной слот, и режим ставится по ней.
  if (!all<{ name: string }>(db, 'PRAGMA table_info(users)').some((c) => c.name === 'theme_mode')) {
    db.exec(`ALTER TABLE users ADD COLUMN theme_night TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE users ADD COLUMN theme_mode TEXT NOT NULL DEFAULT 'system'`);
    const night = `'forest', 'ocean', 'midnight', 'graphite', 'sunset', 'unlocked'`;
    db.exec(`UPDATE users SET theme_night = theme, theme = '', theme_mode = 'night' WHERE theme IN (${night})`);
    db.exec(`UPDATE users SET theme_mode = 'day' WHERE theme <> '' AND theme_mode = 'system'`);
  }
  // Цвета Telegram стали отдельным режимом telegram, а не схемой в списках: пустая дневная схема значит этот режим.
  // Пустые слоты получают схемы по умолчанию. Повторный запуск ничего не меняет: пустых схем больше не бывает
  db.exec(`UPDATE users SET theme_mode = 'telegram' WHERE theme = '' AND theme_mode IN ('day', 'system')`);
  db.exec(`UPDATE users SET theme = 'sky' WHERE theme = ''`);
  db.exec(`UPDATE users SET theme_night = 'midnight' WHERE theme_night = ''`);
  const potColumns = all<{ name: string }>(db, 'PRAGMA table_info(pots)');
  if (!potColumns.some((c) => c.name === 'kind')) {
    db.exec(`ALTER TABLE pots ADD COLUMN kind TEXT NOT NULL DEFAULT 'cash'`);
    db.exec(`ALTER TABLE pots ADD COLUMN ticker TEXT`);
    db.exec(`ALTER TABLE pots ADD COLUMN opening_units REAL NOT NULL DEFAULT 0`);
    db.exec(`UPDATE pots SET kind = 'currency' WHERE currency != 'KZT'`);
  }
  const moveColumns = all<{ name: string }>(db, 'PRAGMA table_info(pot_moves)');
  if (!moveColumns.some((c) => c.name === 'units')) {
    db.exec('ALTER TABLE pot_moves ADD COLUMN units REAL NOT NULL DEFAULT 0');
    db.exec('UPDATE pot_moves SET units = foreign_amount / 100.0 WHERE foreign_amount IS NOT NULL');
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(pot_moves)').some((c) => c.name === 'inactive_at')) {
    // Сделки по вкладам правятся и снимаются как остальные записи: снятая получает inactive_at
    db.exec('ALTER TABLE pot_moves ADD COLUMN inactive_at TEXT');
  }
  const batchColumns = all<{ name: string }>(db, 'PRAGMA table_info(import_batches)');
  if (!batchColumns.some((c) => c.name === 'draft')) {
    // Черновик проверки выписки сохраняется при каждом изменении; sent_at отмечает отправку в учёт
    db.exec('ALTER TABLE import_batches ADD COLUMN draft TEXT');
    db.exec('ALTER TABLE import_batches ADD COLUMN sent_at TEXT');
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(import_batches)').some((c) => c.name === 'locked')) {
    // locked: связи записей с выписками, проставленные при сверке блокнота. Не показываются в отправленных и не отменяются
    db.exec('ALTER TABLE import_batches ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
  }
  const fundColumns = all<{ name: string }>(db, 'PRAGMA table_info(funds)');
  if (!fundColumns.some((c) => c.name === 'pace_alert')) {
    db.exec('ALTER TABLE funds ADD COLUMN pace_alert INTEGER NOT NULL DEFAULT 1');
  }
  if (all<{ name: string }>(db, 'PRAGMA table_info(ledgers)').some((c) => c.name === 'opening_free')) {
    // Свободные средства на начало учёта больше не хранятся в базе: ненулевые переносятся в корректировку первого месяца
    db.exec(`INSERT INTO adjustments (ledger_id, date, amount, comment)
      SELECT id, start_ym || '-01', opening_free, 'Свободные средства на начало учёта' FROM ledgers WHERE opening_free != 0`);
    db.exec('ALTER TABLE ledgers DROP COLUMN opening_free');
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(funds)').some((c) => c.name === 'emoji')) {
    // NULL: эмодзи ещё не подобран, '' : пользователь его стёр
    db.exec('ALTER TABLE funds ADD COLUMN emoji TEXT');
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(users)').some((c) => c.name === 'fund_emoji')) {
    // Личная настройка оформления: показывать эмодзи у фондов
    db.exec('ALTER TABLE users ADD COLUMN fund_emoji INTEGER NOT NULL DEFAULT 1');
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(users)').some((c) => c.name === 'member_emoji')) {
    // Личная настройка оформления: показывать эмодзи у участников
    db.exec('ALTER TABLE users ADD COLUMN member_emoji INTEGER NOT NULL DEFAULT 1');
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(members)').some((c) => c.name === 'emoji')) {
    // Эмодзи участника; его же получает личный фонд участника
    db.exec(`ALTER TABLE members ADD COLUMN emoji TEXT NOT NULL DEFAULT ''`);
    moveMemberEmojis(db);
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(funds)').some((c) => c.name === 'owner_user_id')) {
    // Личный фонд участника выбирается явно; начисления (credit_user_id) идут только в личный фонд
    db.exec('ALTER TABLE funds ADD COLUMN owner_user_id INTEGER');
    assignPersonalFunds(db);
  }
  if (!all<{ name: string }>(db, 'PRAGMA table_info(entries)').some((c) => c.name === 'pot_id')) {
    // Расход, сопутствующий активу (агентские, нотариус, страховка): на стоимость актива не влияет, показывается у актива
    db.exec('ALTER TABLE entries ADD COLUMN pot_id INTEGER REFERENCES pots(id)');
  }
  // Расход по активу может быть без фонда: проверка таблицы entries меняется пересозданием таблицы (в SQLite иначе нельзя)
  const entriesSql = get<{ sql: string }>(db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'`)!.sql;
  const OLD_CHECK = "(kind = 'expense' AND fund_id IS NOT NULL)";
  if (entriesSql.includes(OLD_CHECK)) {
    const indexes = all<{ sql: string }>(db, `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entries' AND sql IS NOT NULL`);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(entriesSql.replace(/CREATE TABLE (IF NOT EXISTS )?"?entries"?/, 'CREATE TABLE entries_new').replace(OLD_CHECK, "(kind = 'expense' AND (fund_id IS NOT NULL OR pot_id IS NOT NULL))"));
      db.exec('INSERT INTO entries_new SELECT * FROM entries');
      db.exec('DROP TABLE entries');
      db.exec('ALTER TABLE entries_new RENAME TO entries');
      for (const i of indexes) db.exec(i.sql);
      if (all(db, 'PRAGMA foreign_key_check').length) throw new Error('Нарушены связи после пересоздания entries');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  fillFundEmojis(db);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function all<T>(db: Db, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: Db, sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}
