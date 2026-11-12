import { memberStats, personalFunds } from './members.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyInitData } from './auth.js';
import { all, get, run, tx, type Db } from './db.js';
import { defaultFundEmoji } from './emoji.js';
import { affectsTotals, listChanges, logChange, revertChange, snapshot, touchesClosed, type EntryState } from './changes.js';
import { BACKUP_INTERVALS, backupSettings, sendBackup, updateBackupSettings, type DocumentSender } from './backup.js';
import { assertWritable, buildReports, closeMonth, createVirtualMember, DomainError, ensurePlans, hiddenFundIds, isClosed, isVirtual, leaveLedger, leavePreview, memberDebts, mergeVirtualMember, paceAlerts, reopenMonth, stopCredits, syncCredits, ymOf } from './domain.js';
import { applyDecisions, createImport, getImport, listOpenImports, listSentImports, revertImport, saveDraft, type UploadedFile } from './imports.js';
import { listQueue, processQueue, removeQueued } from './queue.js';
import { backfillPotPrices, convert, ensureRatesOn, potQuotes, rateOn, saveQuote, valuePots, type MarketSource } from './market.js';
import type { FundSuggester } from './statements/ai.js';
import { noteEntries, noteSettlement, scheduleNext, seriesFields, skipReminder } from './notify.js';
import { checkRefund, checkRefunded } from './refunds.js';
import { archiveFund, archivePreview, lastArchive, restoreFund } from './archive.js';
import { deleteTag, incomeCategories, incomeCategoryOptions, listTags, normalizeTag, normalizeTags, renameTag, setAdjustmentTags, setEntryTags, suggestTags, tagStats } from './tags.js';

export interface AppOptions {
  db: Db;
  botToken: string;
  botUsername?: string;
  /** Telegram ID тех, кто может создавать базы без приглашения */
  ownerIds?: number[];
  devAuth?: boolean;
  suggestFunds: FundSuggester;
  market?: MarketSource;
  webDist?: string;
  /** Отправка копии базы файлом в Telegram; без неё ручная отправка недоступна */
  sendDocument?: DocumentSender;
}

const BASE_CURRENCIES = ['KZT', 'USD', 'EUR', 'RUB', 'KGS', 'UZS', 'GBP', 'TRY', 'CNY', 'AED'] as const;

const DEFAULT_FUNDS = [
  'Еда', 'Кафе', 'Заправки', 'Авто', 'Такси', 'Коммуналка', 'Дом', 'Бытовая химия', 'Садик', 'Учёба', 'Медицина',
  'Одежда', 'Стрижки', 'Спорт', 'Развлечения', 'Подписки', 'Электроника', 'Билеты', 'Подарки', 'Прочее',
];
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
// Цветовые схемы и дизайны базы, оформление задаёт клиент. Пустая строка: цвета Telegram и обычный дизайн
const THEMES = ['', 'forest', 'ocean', 'sand', 'lavender', 'graphite', 'midnight', 'sakura', 'mint', 'sunset', 'paper', 'unlocked', 'peach', 'sky', 'coffee', 'aurora'] as const;
const DESIGNS = ['', 'unlocked', 'mono', 'journal', 'soft', 'compact'] as const;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const Ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const Day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const Money = z.number().int().safe();
const Name = z.string().trim().min(1).max(80);
const Comment = z.string().trim().max(300).default('');
const Tags = z.array(z.string().trim().max(30, 'Тег длиннее 30 символов')).max(10, 'Не больше 10 тегов');

const EntryBody = z.object({
  recalc: z.boolean().default(false),
  tags: Tags.optional(),
  date: Day,
  kind: z.enum(['expense', 'income']),
  amount: Money.refine((v) => v !== 0, 'Сумма не может быть нулевой'),
  fundId: z.number().int().nullable().optional(),
  description: z.string().trim().max(200).default(''),
  comment: Comment,
  paidBy: z.number().int().nullable().optional(),
  earnedBy: z.number().int().nullable().optional(),
  /** Актив для сопутствующего расхода; не передан = не менять */
  potId: z.number().int().nullable().optional(),
  /** Операция подтверждает запланированный платёж */
  reminderId: z.number().int().optional(),
  /** Покупка, к которой относится возврат; не передан = не менять */
  refundOf: z.number().int().nullable().optional(),
});

/** Правка нескольких операций сразу. Сумма задаётся без знака: у возврата минус остаётся */
const BulkBody = z.object({
  ids: z.array(z.number().int()).min(1, 'Отметь операции').max(500, 'Не больше 500 операций за раз'),
  delete: z.boolean().default(false),
  addTags: Tags.default([]),
  removeTags: z.array(z.string().trim().max(30)).max(50).default([]),
  fundId: z.number().int().optional(),
  comment: z.string().trim().max(300).optional(),
  amount: Money.positive().optional(),
  recalc: z.boolean().default(false),
});

const ReminderBody = z.object({
  comment: z.string().trim().min(1, 'Напиши, за что платёж').max(300),
  amount: Money.positive().nullable().default(null),
  fundId: z.number().int().nullable().default(null),
  dueDate: Day,
  /** Момент напоминания, миллисекунды UTC */
  remindAt: z.number().int().positive(),
  repeat: z.enum(['week', 'month']).nullable().default(null),
  /** Время оплаты ЧЧ:ММ */
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
  /** Число месяца для ежемесячного: 31 в коротком месяце даёт последний день, а дальше снова 31 */
  anchorDay: z.number().int().min(1).max(31).optional(),
});

const AdjustmentBody = z.object({
  date: Day,
  amount: Money.refine((v) => v !== 0, 'Сумма не может быть нулевой'),
  comment: z.string().trim().min(1, 'Укажи причину корректировки').max(300),
  tags: Tags.default([]),
  recalc: z.boolean().default(false),
});

/** ?recalc=1 у удаления: согласие на пересчёт закрытого месяца. */
const recalcQuery = (req: FastifyRequest) => (req.query as any)?.recalc === '1';

const DecisionsBody = z.object({
  decisions: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ rowId: z.number().int(), action: z.literal('skip') }),
        z.object({ rowId: z.number().int(), action: z.literal('income'), comment: Comment, amount: Money.positive().optional(), earnedBy: z.number().int().nullable().optional(), tags: Tags.default([]) }),
        z.object({ rowId: z.number().int(), action: z.literal('merge'), intoRowId: z.number().int() }),
        z.object({ rowId: z.number().int(), action: z.literal('settlement'), userId: z.number().int(), comment: z.string().trim().max(300).optional(), amount: Money.positive().optional() }),
        z.object({
          rowId: z.number().int(),
          action: z.literal('expense'),
          tags: Tags.default([]),
          parts: z.array(z.object({ fundId: z.number().int(), amount: Money, comment: Comment, refundOf: z.number().int().nullable().optional() })).min(1),
        }),
      ]),
    )
    .min(1),
});

function currentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Поиск по операциям: каждое слово запроса должно найтись в описании, комментарии, фонде, тегах или именах,
 * а число ищется и в сумме (без пробелов и копеек). SQLite не умеет переводить кириллицу в нижний регистр, поэтому фильтр в коде.
 */
export function matchesSearch(
  e: { amount: number; description: string; comment: string; fundName: string | null; tags: string[]; paidByName: string | null; earnedByName: string | null },
  search: string,
): boolean {
  const text = [e.description, e.comment, e.fundName, e.paidByName, e.earnedByName, ...e.tags].filter(Boolean).join(' ').toLowerCase().replace(/ё/g, 'е');
  const amount = String(Math.round(Math.abs(e.amount) / 100));
  // Сумму можно набрать с пробелами: «529 020»
  const digits = search.replace(/[\s.,]/g, '');
  if (/^\d+$/.test(digits) && amount.includes(digits)) return true;
  return search
    .replace(/ё/g, 'е')
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word.replace(/^#/, '')) || (/^\d+$/.test(word) && amount.includes(word)));
}

export function buildApp(options: AppOptions) {
  const { db, botToken, suggestFunds } = options;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 5 } });

  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof DomainError) return reply.status(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.status(400).send({ error: error.issues[0]?.message ?? 'Неверные данные' });
    if (error.statusCode && error.statusCode < 500) return reply.status(error.statusCode).send({ error: 'Неверный запрос или слишком большой файл' });
    console.error(error);
    return reply.status(500).send({ error: 'Внутренняя ошибка сервера' });
  });

  function authenticate(req: FastifyRequest): { id: number; name: string } {
    const dev = req.headers['x-dev-user'];
    if (options.devAuth && typeof dev === 'string' && /^\d+$/.test(dev)) {
      const id = Number(dev);
      const name = `Тест ${id}`;
      run(db, 'INSERT INTO users (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', id, name);
      return get<{ id: number; name: string }>(db, 'SELECT id, name FROM users WHERE id = ?', id)!;
    }
    const header = req.headers.authorization ?? '';
    const user = header.startsWith('tma ') ? verifyInitData(header.slice(4), botToken) : null;
    if (!user) throw new DomainError('Сессия устарела. Открой приложение из Telegram заново.', 401);
    run(
      db,
      'INSERT INTO users (id, name, username) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, username = excluded.username',
      user.id,
      user.name,
      user.username ?? null,
    );
    return user;
  }

  const L = '/api/ledgers/:ledgerId';

  function access(req: FastifyRequest, adminOnly = false) {
    const user = authenticate(req);
    const ledgerId = Number((req.params as any).ledgerId);
    const member = get<{ role: string; display_name: string }>(db, 'SELECT role, display_name FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, user.id);
    if (!member) throw new DomainError('Нет доступа к этой базе', 403);
    const isAdmin = member.role === 'admin';
    if (adminOnly && !isAdmin) throw new DomainError('Это может только администратор', 403);
    // Заблокированная база только читается; снять блокировку можно в её настройках
    const locked = !!get<{ locked: number }>(db, 'SELECT locked FROM ledgers WHERE id = ?', ledgerId)?.locked;
    const unlocking = req.method === 'PATCH' && req.routeOptions.url === L;
    // Выйти можно и из заблокированной базы: участник не может снять блокировку сам
    const leaving = req.method === 'POST' && req.routeOptions.url === `${L}/leave`;
    // Копия на данные не влияет: её можно настроить и отправить и у заблокированной базы
    const backup = req.routeOptions.url?.startsWith(`${L}/backup`);
    if (locked && req.method !== 'GET' && !unlocking && !leaving && !backup) throw new DomainError('База заблокирована. Сними блокировку в настройках базы.', 423);
    // Начисления появляются сами с наступлением месяца и следуют за планом
    if (!locked) tx(db, () => syncCredits(db, ledgerId, currentYm()));
    return { userId: user.id, ledgerId, isAdmin };
  }

  // Новые люди попадают в сервис только по приглашению; приглашённый может завести и свою базу
  function canCreateLedger(userId: number): boolean {
    return (
      isOwner(userId) ||
      !!get(db, 'SELECT 1 x FROM members WHERE user_id = ? AND inactive_at IS NULL LIMIT 1', userId) ||
      !!get(db, 'SELECT 1 x FROM service_invites WHERE used_by = ? LIMIT 1', userId)
    );
  }

  function isOwner(userId: number): boolean {
    return (options.ownerIds ?? []).includes(userId);
  }

  function inviteLink(token: string): string | null {
    return options.botUsername ? `https://t.me/${options.botUsername}?startapp=${token}` : null;
  }

  /** Делает фонд личным фондом участника (или ничьим). У участника один личный фонд; начисления идут только в личный фонд. */
  function setFundOwner(ledgerId: number, fundId: number, owner: number | null) {
    const stop = (id: number) => {
      stopCredits(db, ledgerId, id);
      run(db, 'UPDATE funds SET credit_user_id = NULL, credit_from = NULL WHERE id = ?', id);
    };
    const fund = get<{ credit_user_id: number | null }>(db, 'SELECT credit_user_id FROM funds WHERE id = ?', fundId)!;
    if (fund.credit_user_id !== null && fund.credit_user_id !== owner) stop(fundId);
    if (owner !== null) {
      for (const old of all<{ id: number; credit_user_id: number | null }>(db, 'SELECT id, credit_user_id FROM funds WHERE ledger_id = ? AND owner_user_id = ? AND id <> ?', ledgerId, owner, fundId)) {
        if (old.credit_user_id !== null) stop(old.id);
        run(db, 'UPDATE funds SET owner_user_id = NULL WHERE id = ?', old.id);
      }
    }
    run(db, 'UPDATE funds SET owner_user_id = ? WHERE id = ?', owner, fundId);
  }

  /** Эмодзи фондов и участников базы по названию и имени; личный фонд участника получает эмодзи участника. */
  function ledgerEmojis(ledgerId: number, fundEmojis: Record<string, string>) {
    const members = all<{ userId: number; name: string; emoji: string }>(db, 'SELECT user_id userId, display_name name, emoji FROM members WHERE ledger_id = ? AND inactive_at IS NULL', ledgerId);
    const funds = { ...fundEmojis };
    const own = personalFunds(db, ledgerId, members);
    for (const m of members) {
      const fund = own.get(m.userId);
      if (fund && m.emoji) funds[fund.name] = m.emoji;
    }
    return { fundEmojis: funds, memberEmojis: Object.fromEntries(members.filter((m) => m.emoji).map((m) => [m.name, m.emoji])) as Record<string, string> };
  }

  function listLedgers(userId: number) {
    return all<{ locked: number }>(
      db,
      `SELECT l.id, l.name, l.start_ym startYm, l.currency, l.locked, m.role, m.display_name displayName,
         (SELECT json_group_object(f.name, f.emoji) FROM funds f WHERE f.ledger_id = l.id AND f.emoji <> '') fundEmojis
       FROM ledgers l JOIN members m ON m.ledger_id = l.id WHERE m.user_id = ? AND m.inactive_at IS NULL ORDER BY l.id`,
      userId,
    ).map((l) => ({ ...l, locked: !!l.locked, ...ledgerEmojis((l as unknown as { id: number }).id, JSON.parse((l as { fundEmojis?: string }).fundEmojis ?? '{}') as Record<string, string>) }));
  }

  app.get('/api/me', async (req) => {
    const user = authenticate(req);
    const look = get<{ theme: string; theme_night: string; theme_mode: string; design: string; fund_emoji: number; member_emoji: number; notify: number }>(db, 'SELECT theme, theme_night, theme_mode, design, fund_emoji, member_emoji, notify FROM users WHERE id = ?', user.id);
    return { user: { id: user.id, name: user.name, theme: look?.theme || 'sky', themeNight: look?.theme_night || 'midnight', themeMode: !look?.theme ? 'telegram' : look.theme_mode, design: look?.design ?? '', fundEmoji: look ? !!look.fund_emoji : true, memberEmoji: look ? !!look.member_emoji : true, notify: look ? !!look.notify : true }, ledgers: listLedgers(user.id), currentYm: currentYm(), canCreateLedger: canCreateLedger(user.id), isOwner: isOwner(user.id) };
  });

  // Оформление личное: одно на все базы человека
  app.patch('/api/me', async (req) => {
    const user = authenticate(req);
    const body = z.object({ theme: z.enum(THEMES).optional(), themeNight: z.enum(THEMES).optional(), themeMode: z.enum(['system', 'day', 'night', 'telegram']).optional(), design: z.enum(DESIGNS).optional(), fundEmoji: z.boolean().optional(), memberEmoji: z.boolean().optional(), notify: z.boolean().optional() }).parse(req.body);
    if (body.fundEmoji !== undefined) run(db, 'UPDATE users SET fund_emoji = ? WHERE id = ?', body.fundEmoji ? 1 : 0, user.id);
    if (body.memberEmoji !== undefined) run(db, 'UPDATE users SET member_emoji = ? WHERE id = ?', body.memberEmoji ? 1 : 0, user.id);
    if (body.notify !== undefined) run(db, 'UPDATE users SET notify = ? WHERE id = ?', body.notify ? 1 : 0, user.id);
    // Новый человек ещё без схем: при первом выборе оформления пустые слоты получают схемы по умолчанию
    if (body.theme !== undefined || body.themeNight !== undefined || body.themeMode !== undefined) {
      run(db, `UPDATE users SET theme = CASE WHEN theme = '' THEN 'sky' ELSE theme END, theme_night = CASE WHEN theme_night = '' THEN 'midnight' ELSE theme_night END WHERE id = ?`, user.id);
    }
    if (body.themeNight !== undefined) run(db, 'UPDATE users SET theme_night = ? WHERE id = ?', body.themeNight, user.id);
    if (body.themeMode !== undefined) run(db, 'UPDATE users SET theme_mode = ? WHERE id = ?', body.themeMode, user.id);
    if (body.theme !== undefined) run(db, 'UPDATE users SET theme = ? WHERE id = ?', body.theme, user.id);
    if (body.design !== undefined) run(db, 'UPDATE users SET design = ? WHERE id = ?', body.design, user.id);
    return { ok: true };
  });

  app.post('/api/ledgers', async (req) => {
    const user = authenticate(req);
    if (!canCreateLedger(user.id)) throw new DomainError('Войти можно только по приглашению.', 403);
    const body = z
      .object({ name: Name, startYm: Ym.optional(), currency: z.enum(BASE_CURRENCIES).default('KZT'), personalFunds: z.array(Name).max(20).default([]) })
      .parse(req.body);
    const id = tx(db, () => {
      const ledgerId = Number(
        run(db, 'INSERT INTO ledgers (name, start_ym, currency, created_by) VALUES (?, ?, ?, ?)', body.name, body.startYm ?? currentYm(), body.currency, user.id).lastInsertRowid,
      );
      run(db, `INSERT INTO members (ledger_id, user_id, role, display_name) VALUES (?, ?, 'admin', ?)`, ledgerId, user.id, user.name);
      const names = [...DEFAULT_FUNDS.slice(0, -1), ...body.personalFunds.map((p) => `Личные: ${p}`), DEFAULT_FUNDS.at(-1)!];
      names.forEach((name, i) => run(db, 'INSERT OR IGNORE INTO funds (ledger_id, name, sort, emoji) VALUES (?, ?, ?, ?)', ledgerId, name, i, defaultFundEmoji(name)));
      return ledgerId;
    });
    return { id };
  });

  app.post('/api/invites/accept', async (req) => {
    const user = authenticate(req);
    const { token } = z.object({ token: z.string().min(8).max(100) }).parse(req.body);
    const service = get<{ expires_at: number; used_by: number | null }>(db, 'SELECT expires_at, used_by FROM service_invites WHERE token = ?', token);
    if (service) {
      if (service.used_by === user.id) return { ledgerId: null };
      const claimed = run(db, 'UPDATE service_invites SET used_by = ? WHERE token = ? AND used_by IS NULL AND expires_at >= ?', user.id, token, Date.now());
      if (!claimed.changes) throw new DomainError('Приглашение уже использовано или устарело. Попроси новое.', 404);
      return { ledgerId: null };
    }
    const invite = get<{ ledger_id: number; expires_at: number; virtual_user_id: number | null }>(db, 'SELECT ledger_id, expires_at, virtual_user_id FROM invites WHERE token = ?', token);
    if (!invite || invite.expires_at < Date.now()) throw new DomainError('Приглашение недействительно или устарело. Попроси новое.', 404);
    // Такая ссылка одноразовая: при слиянии приглашения этого участника удаляются
    if (invite.virtual_user_id !== null) {
      const virtualId = invite.virtual_user_id;
      tx(db, () => mergeVirtualMember(db, invite.ledger_id, virtualId, user.id));
      return { ledgerId: invite.ledger_id };
    }
    // Человек уже был в базе и вышел: он возвращается в свой прежний профиль со всей историей
    const former = get<{ user_id: number }>(db, 'SELECT user_id FROM members WHERE ledger_id = ? AND former_user_id = ? AND inactive_at IS NULL', invite.ledger_id, user.id);
    if (former && !get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', invite.ledger_id, user.id)) {
      tx(db, () => mergeVirtualMember(db, invite.ledger_id, former.user_id, user.id));
      return { ledgerId: invite.ledger_id };
    }
    run(
      db,
      `INSERT INTO members (ledger_id, user_id, role, display_name) VALUES (?, ?, 'member', ?)
       ON CONFLICT (ledger_id, user_id) DO UPDATE SET inactive_at = NULL`,
      invite.ledger_id,
      user.id,
      user.name,
    );
    return { ledgerId: invite.ledger_id };
  });

  app.post('/api/service-invites', async (req) => {
    const user = authenticate(req);
    if (!isOwner(user.id)) throw new DomainError('Это может только владелец сервиса', 403);
    const token = randomBytes(16).toString('hex');
    run(db, 'INSERT INTO service_invites (token, created_by, expires_at) VALUES (?, ?, ?)', token, user.id, Date.now() + INVITE_TTL_MS);
    return { token, link: inviteLink(token) };
  });


  // Копия базы в Telegram: настройки у администратора базы, отправка вручную себе в личку
  app.get(`${L}/backup`, async (req) => {
    const { ledgerId } = access(req, true);
    return { ...backupSettings(db, ledgerId), intervals: BACKUP_INTERVALS, canSend: !!options.sendDocument };
  });

  app.patch(`${L}/backup`, async (req) => {
    const { ledgerId } = access(req, true);
    const body = z
      .object({ enabled: z.boolean().optional(), days: z.number().int().refine((d) => (BACKUP_INTERVALS as readonly number[]).includes(d), 'Такого интервала нет').optional() })
      .parse(req.body);
    return updateBackupSettings(db, ledgerId, body);
  });

  app.post(`${L}/backup/send`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    if (!options.sendDocument) throw new DomainError('Бот не настроен: отправить копию некому.', 503);
    try {
      return { sent: await sendBackup(db, options.sendDocument, ledgerId, [userId]), ...backupSettings(db, ledgerId) };
    } catch (e) {
      throw new DomainError(`Копия не отправлена: ${(e as Error).message}`, 502);
    }
  });

  app.patch(L, async (req) => {
    const { ledgerId } = access(req, true);
    const body = z
      .object({ name: Name.optional(), startYm: Ym.optional(), locked: z.boolean().optional() })
      .parse(req.body);
    const locked = !!get<{ locked: number }>(db, 'SELECT locked FROM ledgers WHERE id = ?', ledgerId)!.locked;
    if (locked && body.locked !== false && (body.name !== undefined || body.startYm !== undefined)) {
      throw new DomainError('База заблокирована. Сними блокировку, чтобы менять настройки.', 423);
    }
    if (body.startYm !== undefined) {
      if (get(db, 'SELECT 1 x FROM closed_months WHERE ledger_id = ? LIMIT 1', ledgerId)) {
        throw new DomainError('Стартовый месяц нельзя менять после закрытия первого месяца.');
      }
      const early = get(db, 'SELECT 1 x FROM entries WHERE ledger_id = ? AND inactive_at IS NULL AND substr(date, 1, 7) < ? LIMIT 1', ledgerId, body.startYm);
      if (early) throw new DomainError('Есть операции раньше этого месяца.');
    }
    if (body.name !== undefined) run(db, 'UPDATE ledgers SET name = ? WHERE id = ?', body.name, ledgerId);
    if (body.startYm !== undefined) run(db, 'UPDATE ledgers SET start_ym = ? WHERE id = ?', body.startYm, ledgerId);
    if (body.locked !== undefined) run(db, 'UPDATE ledgers SET locked = ? WHERE id = ?', body.locked ? 1 : 0, ledgerId);
    return { ok: true };
  });

  app.get(`${L}/summary`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    const ym = Ym.parse((req.query as any).ym ?? currentYm());
    const ledger = get<{ start_ym: string }>(db, 'SELECT start_ym FROM ledgers WHERE id = ?', ledgerId)!;
    if (ym < ledger.start_ym) throw new DomainError(`База начинается с ${ledger.start_ym}.`);
    if (!isClosed(db, ledgerId, ym)) ensurePlans(db, ledgerId, ym);
    const reports = buildReports(db, ledgerId, ym);
    const debts = memberDebts(db, ledgerId);
    const lastClosed = get<{ ym: string | null }>(db, 'SELECT MAX(ym) ym FROM closed_months WHERE ledger_id = ?', ledgerId)?.ym ?? null;
    const alerts = paceAlerts(db, ledgerId, ym, new Date().toISOString().slice(0, 10));
    return { report: reports.at(-1), startYm: ledger.start_ym, lastClosed, isAdmin, debts: isAdmin ? debts : debts.filter((d) => d.userId === userId), paceAlerts: alerts };
  });

  app.get(`${L}/history`, async (req) => {
    const { ledgerId } = access(req);
    const ledger = get<{ start_ym: string }>(db, 'SELECT start_ym FROM ledgers WHERE id = ?', ledgerId)!;
    // До последнего закрытого месяца, а если прошлые месяцы не закрыты, то до прошлого: они приходят с closed = false
    // и показываются серыми только в «Капитале»; остальная статистика строится по закрытым
    const lastClosed = get<{ ym: string | null }>(db, 'SELECT MAX(ym) ym FROM closed_months WHERE ledger_id = ?', ledgerId)?.ym ?? null;
    const [y, m] = currentYm().split('-').map(Number);
    const previous = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const to = lastClosed && lastClosed > previous ? lastClosed : previous;
    return { months: to >= ledger.start_ym ? buildReports(db, ledgerId, to) : [], startYm: ledger.start_ym };
  });

  app.put(`${L}/plans/:ym`, async (req) => {
    const { ledgerId } = access(req, true);
    const ym = Ym.parse((req.params as any).ym);
    const { items } = z.object({ items: z.array(z.object({ fundId: z.number().int(), amount: Money.nonnegative() })) }).parse(req.body);
    if (isClosed(db, ledgerId, ym)) throw new DomainError(`Месяц ${ym} закрыт.`);
    tx(db, () => {
      for (const item of items) {
        if (!get(db, 'SELECT 1 x FROM funds WHERE id = ? AND ledger_id = ?', item.fundId, ledgerId)) throw new DomainError('Фонд не найден', 404);
        run(
          db,
          `INSERT INTO plans (ledger_id, ym, fund_id, amount) VALUES (?, ?, ?, ?)
           ON CONFLICT (ledger_id, ym, fund_id) DO UPDATE SET amount = excluded.amount`,
          ledgerId,
          ym,
          item.fundId,
          item.amount,
        );
      }
    });
    return { ok: true };
  });

  app.post(`${L}/months/:ym/close`, async (req) => {
    const { ledgerId } = access(req, true);
    closeMonth(db, ledgerId, Ym.parse((req.params as any).ym));
    return { ok: true };
  });

  app.post(`${L}/months/:ym/reopen`, async (req) => {
    const { ledgerId } = access(req, true);
    reopenMonth(db, ledgerId, Ym.parse((req.params as any).ym));
    return { ok: true };
  });

  app.get(`${L}/funds`, async (req) => {
    const { ledgerId } = access(req);
    const rows = all<{ id: number; archived: number }>(db, `SELECT id, name, COALESCE(emoji, '') emoji, opening_balance openingBalance, archived, sort, pace_alert paceAlert, credit_user_id creditUserId, owner_user_id ownerUserId FROM funds WHERE ledger_id = ? ORDER BY sort, id`, ledgerId);
    // У архивного фонда видно, когда и как его архивировали
    return rows.map((f) => {
      const a = f.archived ? lastArchive(db, ledgerId, f.id) : undefined;
      const name = (id: number | null) => (id ? get<{ name: string }>(db, 'SELECT name FROM funds WHERE id = ?', id)?.name ?? null : null);
      return { ...f, archive: a ? { date: a.created_at.slice(0, 10), mode: a.mode, targetName: name(a.target_fund_id), balanceToName: name(a.balance_to_fund_id) } : null };
    });
  });

  // Архивация фонда: сначала видно, что у него есть, потом выбирается, куда деть операции и остаток
  app.get(`${L}/funds/:fundId/archive`, async (req) => {
    const { ledgerId } = access(req, true);
    return archivePreview(db, ledgerId, Number((req.params as any).fundId), currentYm());
  });

  app.post(`${L}/funds/:fundId/archive`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const body = z.object({
      mode: z.enum(['keep', 'move', 'split']),
      targetFundId: z.number().int().nullable().default(null),
      balanceToFundId: z.number().int().nullable().default(null),
      assignments: z.array(z.object({ entryId: z.number().int(), fundId: z.number().int() })).max(5000).default([]),
      recalc: z.boolean().default(false),
    }).parse(req.body);
    return tx(db, () => archiveFund(db, ledgerId, userId, Number((req.params as any).fundId), body, today()));
  });

  app.post(`${L}/funds/:fundId/restore`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const { recalc } = z.object({ recalc: z.boolean().default(false) }).parse(req.body ?? {});
    return tx(db, () => restoreFund(db, ledgerId, userId, Number((req.params as any).fundId), recalc));
  });

  // Переносы остатков между фондами и свободными: «Деньги» не меняют
  app.get(`${L}/transfers`, async (req) => {
    const { ledgerId } = access(req);
    return all<{ closed: number }>(
      db,
      `SELECT t.id, t.date, t.amount, t.comment, t.from_fund_id fromFundId, t.to_fund_id toFundId, t.archive_id archiveId,
         (SELECT name FROM funds WHERE id = t.from_fund_id) fromName, (SELECT name FROM funds WHERE id = t.to_fund_id) toName,
         EXISTS (SELECT 1 FROM closed_months c WHERE c.ledger_id = t.ledger_id AND c.ym = substr(t.date, 1, 7)) closed
       FROM fund_transfers t WHERE t.ledger_id = ? AND t.inactive_at IS NULL ORDER BY t.date DESC, t.id DESC`,
      ledgerId,
    ).map((t) => ({ ...t, closed: !!t.closed }));
  });

  app.post(`${L}/transfers`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const body = z.object({
      date: Day,
      amount: Money.positive(),
      fromFundId: z.number().int().nullable(),
      toFundId: z.number().int().nullable(),
      comment: Comment,
      recalc: z.boolean().default(false),
    }).parse(req.body);
    if (body.fromFundId === body.toFundId) throw new DomainError('Откуда и куда должны различаться.');
    for (const id of [body.fromFundId, body.toFundId]) {
      if (id !== null && !get(db, 'SELECT 1 x FROM funds WHERE id = ? AND ledger_id = ?', id, ledgerId)) throw new DomainError('Фонд не найден', 404);
    }
    assertWritable(db, ledgerId, body.date, body.recalc);
    const id = tx(db, () => {
      const id = Number(run(db, 'INSERT INTO fund_transfers (ledger_id, date, amount, from_fund_id, to_fund_id, comment, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', ledgerId, body.date, body.amount, body.fromFundId, body.toFundId, body.comment, userId).lastInsertRowid);
      if (touchesClosed(db, ledgerId, body.date)) logChange(db, ledgerId, userId, 'transfer', id, 'create', null, snapshot(db, 'transfer', id));
      return id;
    });
    return { id };
  });

  app.delete(`${L}/transfers/:id`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const id = Number((req.params as any).id);
    const row = get<{ date: string; archive_id: number | null }>(db, 'SELECT date, archive_id FROM fund_transfers WHERE id = ? AND ledger_id = ? AND inactive_at IS NULL', id, ledgerId);
    if (!row) throw new DomainError('Запись не найдена', 404);
    if (row.archive_id) throw new DomainError('Этот перенос сделала архивация фонда. Он снимется, если вернуть фонд из архива.');
    assertWritable(db, ledgerId, row.date, recalcQuery(req));
    tx(db, () => {
      const before = snapshot(db, 'transfer', id);
      run(db, `UPDATE fund_transfers SET inactive_at = datetime('now') WHERE id = ?`, id);
      if (touchesClosed(db, ledgerId, row.date)) logChange(db, ledgerId, userId, 'transfer', id, 'delete', before, null);
    });
    return { ok: true };
  });

  app.post(`${L}/funds`, async (req) => {
    const { ledgerId } = access(req, true);
    const body = z.object({ name: Name, openingBalance: Money.default(0) }).parse(req.body);
    if (get(db, 'SELECT 1 x FROM funds WHERE ledger_id = ? AND name = ?', ledgerId, body.name)) throw new DomainError('Такой фонд уже есть.');
    const sort = get<{ s: number }>(db, 'SELECT COALESCE(MAX(sort), 0) + 1 s FROM funds WHERE ledger_id = ?', ledgerId)!.s;
    const id = run(db, 'INSERT INTO funds (ledger_id, name, opening_balance, sort, emoji) VALUES (?, ?, ?, ?, ?)', ledgerId, body.name, body.openingBalance, sort, defaultFundEmoji(body.name)).lastInsertRowid;
    return { id: Number(id) };
  });

  app.patch(`${L}/funds/:fundId`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const fundId = Number((req.params as any).fundId);
    const body = z.object({ name: Name.optional(), emoji: z.string().trim().max(16).optional(), openingBalance: Money.optional(), archived: z.boolean().optional(), paceAlert: z.boolean().optional(), creditUserId: z.number().int().nullable().optional(), ownerUserId: z.number().int().nullable().optional() }).parse(req.body);
    if (!get(db, 'SELECT 1 x FROM funds WHERE id = ? AND ledger_id = ?', fundId, ledgerId)) throw new DomainError('Фонд не найден', 404);
    if (body.name !== undefined) run(db, 'UPDATE funds SET name = ? WHERE id = ?', body.name, fundId);
    if (body.emoji !== undefined) run(db, 'UPDATE funds SET emoji = ? WHERE id = ?', body.emoji, fundId);
    if (body.openingBalance !== undefined) run(db, 'UPDATE funds SET opening_balance = ? WHERE id = ?', body.openingBalance, fundId);
    if (body.archived === false) restoreFund(db, ledgerId, userId, fundId, false);
    if (body.archived === true) {
      if (!archivePreview(db, ledgerId, fundId, currentYm()).empty) throw new DomainError('У фонда есть операции или план: архивируй его через «В архив», там выбирается, куда их деть.');
      archiveFund(db, ledgerId, userId, fundId, { mode: 'keep', targetFundId: null, balanceToFundId: null, assignments: [], recalc: false }, today());
    }
    if (body.paceAlert !== undefined) run(db, 'UPDATE funds SET pace_alert = ? WHERE id = ?', body.paceAlert ? 1 : 0, fundId);
    if (body.ownerUserId !== undefined) {
      const owner = body.ownerUserId;
      if (owner !== null && !get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, owner)) {
        throw new DomainError('Участник не найден', 404);
      }
      tx(db, () => {
        setFundOwner(ledgerId, fundId, owner);
        syncCredits(db, ledgerId, currentYm());
      });
    }
    if (body.creditUserId !== undefined) {
      const creditUserId = body.creditUserId;
      if (creditUserId !== null && !get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, creditUserId)) {
        throw new DomainError('Участник не найден', 404);
      }
      const owner = get<{ owner_user_id: number | null }>(db, 'SELECT owner_user_id FROM funds WHERE id = ?', fundId)!.owner_user_id;
      if (creditUserId !== null && owner !== null && owner !== creditUserId) throw new DomainError('Это личный фонд другого участника.');
      tx(db, () => {
        // Начисления идут только в личный фонд: свободный фонд становится личным фондом участника
        if (creditUserId !== null && owner === null) setFundOwner(ledgerId, fundId, creditUserId);
        const current = get<{ credit_user_id: number | null }>(db, 'SELECT credit_user_id FROM funds WHERE id = ?', fundId)!.credit_user_id;
        if (creditUserId === null) {
          stopCredits(db, ledgerId, fundId);
          run(db, 'UPDATE funds SET credit_user_id = NULL, credit_from = NULL WHERE id = ?', fundId);
        } else if (current === null) {
          run(db, 'UPDATE funds SET credit_user_id = ?, credit_from = ? WHERE id = ?', creditUserId, currentYm(), fundId);
        } else {
          run(db, 'UPDATE funds SET credit_user_id = ? WHERE id = ?', creditUserId, fundId);
        }
        syncCredits(db, ledgerId, currentYm());
      });
    }
    return { ok: true };
  });

  app.get(`${L}/entries`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    const hidden = hiddenFundIds(db, ledgerId, userId, isAdmin);
    const q = req.query as any;
    // Месяц (ym) или диапазон месяцев включительно (from, to)
    const from = Ym.parse(q.from ?? q.ym ?? currentYm());
    const to = Ym.parse(q.to ?? from);
    const fund = q.fundId ? Number(q.fundId) : null;
    const tag = q.tagId ? Number(q.tagId) : null;
    // Вид: доходы или расходы (возврат это расход с минусом и к доходам не относится)
    const kind = q.kind === 'income' || q.kind === 'expense' ? q.kind : null;
    const search = typeof q.q === 'string' ? q.q.trim().toLowerCase().slice(0, 100) : '';
    const rows = all<{ tags: string; closed: number; amount: number; description: string; comment: string; fundName: string | null; paidByName: string | null; earnedByName: string | null; refundOf: string | null; refunded: number | null }>(
      db,
      `SELECT e.id, e.date, e.kind, e.amount, e.fund_id fundId, f.name fundName, e.description, e.comment, e.paid_by paidBy, e.pot_id potId,
         (SELECT name FROM pots WHERE id = e.pot_id) potName,
         m.display_name paidByName, e.created_by createdBy, e.earned_by earnedBy, em.display_name earnedByName, e.auto_credit autoCredit,
         EXISTS (SELECT 1 FROM closed_months c WHERE c.ledger_id = e.ledger_id AND c.ym = substr(e.date, 1, 7)) closed,
         (SELECT json_group_array(t.name) FROM entry_tags et JOIN tags t ON t.id = et.tag_id AND t.inactive_at IS NULL WHERE et.entry_id = e.id) tags,
         (SELECT json_object('id', o.id, 'date', o.date, 'amount', o.amount, 'note', CASE WHEN o.comment <> '' THEN o.comment ELSE o.description END)
            FROM entries o WHERE o.id = e.refund_of AND o.inactive_at IS NULL) refundOf,
         (SELECT -SUM(r.amount) FROM entries r WHERE r.refund_of = e.id AND r.inactive_at IS NULL) refunded
       FROM entries e LEFT JOIN funds f ON f.id = e.fund_id
       LEFT JOIN members m ON m.ledger_id = e.ledger_id AND m.user_id = e.paid_by
       LEFT JOIN members em ON em.ledger_id = e.ledger_id AND em.user_id = e.earned_by
       WHERE e.ledger_id = ? AND e.inactive_at IS NULL AND substr(e.date, 1, 7) BETWEEN ? AND ? AND (? IS NULL OR e.fund_id = ?) AND (? IS NULL OR e.kind = ?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM entry_tags x WHERE x.entry_id = e.id AND x.tag_id = ?))
       ORDER BY e.date DESC, e.id DESC`,
      ledgerId,
      from,
      to,
      fund,
      fund,
      kind,
      kind,
      tag,
      tag,
    )
      .filter((e) => !(e as any).fundId || !hidden.has((e as any).fundId))
      .map((e) => ({ ...e, closed: !!e.closed, tags: JSON.parse(e.tags) as string[], refundOf: e.refundOf ? JSON.parse(e.refundOf) : null, refunded: e.refunded ?? 0 }));
    return search ? rows.filter((e) => matchesSearch(e, search)) : rows;
  });

  // Покупки, к которым можно привязать возврат: ещё не возвращённые целиком, новые сверху.
  // include: текущая привязка, она нужна в списке, даже если покупка уже возвращена; except: сам возврат, его сумма не считается
  app.get(`${L}/entries/refundable`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    const hidden = hiddenFundIds(db, ledgerId, userId, isAdmin);
    const q = req.query as any;
    const fund = q.fundId ? Number(q.fundId) : null;
    const include = q.include ? Number(q.include) : null;
    const except = q.except ? Number(q.except) : null;
    const search = typeof q.q === 'string' ? q.q.trim().toLowerCase().slice(0, 100) : '';
    const rows = all<{ id: number; fundId: number | null; amount: number; refunded: number; description: string; comment: string; fundName: string | null }>(
      db,
      `SELECT e.id, e.date, e.amount, e.fund_id fundId, f.name fundName, e.description, e.comment,
         COALESCE((SELECT -SUM(r.amount) FROM entries r WHERE r.refund_of = e.id AND r.inactive_at IS NULL AND r.id IS NOT ?), 0) refunded
       FROM entries e LEFT JOIN funds f ON f.id = e.fund_id
       WHERE e.ledger_id = ? AND e.inactive_at IS NULL AND e.kind = 'expense' AND e.amount > 0 AND e.auto_credit = 0 AND (? IS NULL OR e.fund_id = ? OR e.id = ?)
       ORDER BY e.date DESC, e.id DESC`,
      except,
      ledgerId,
      fund,
      fund,
      include,
    ).filter((e) => (e.amount > e.refunded || e.id === include) && (!e.fundId || !hidden.has(e.fundId)));
    const found = search ? rows.filter((e) => e.id === include || matchesSearch({ ...e, tags: [], paidByName: null, earnedByName: null }, search)) : rows;
    // Текущая привязка остаётся в списке, даже если она старше полусотни последних покупок
    const top = found.slice(0, 50);
    const current = found.find((e) => e.id === include);
    return current && !top.includes(current) ? [current, ...top] : top;
  });

  app.get(`${L}/incomes`, async (req) => {
    const { ledgerId } = access(req);
    return all(
      db,
      `SELECT substr(e.date, 1, 7) ym, e.earned_by userId, COALESCE(m.display_name, u.name) name, SUM(e.amount) total, COUNT(*) count
       FROM entries e LEFT JOIN members m ON m.ledger_id = e.ledger_id AND m.user_id = e.earned_by
       LEFT JOIN users u ON u.id = e.earned_by
       WHERE e.ledger_id = ? AND e.kind = 'income' AND e.inactive_at IS NULL GROUP BY ym, e.earned_by ORDER BY ym`,
      ledgerId,
    );
  });

  // Расходы участников за счёт базы и выплаты им по месяцам: из этого складывается долг базы
  app.get(`${L}/members/stats`, async (req) => {
    const { ledgerId } = access(req);
    return memberStats(db, ledgerId);
  });

  app.get(`${L}/incomes/categories`, async (req) => {
    const { ledgerId } = access(req);
    return incomeCategories(db, ledgerId);
  });

  app.get(`${L}/tags`, async (req) => {
    const { ledgerId } = access(req);
    return listTags(db, ledgerId);
  });

  app.get(`${L}/tags/suggest`, async (req) => {
    const { ledgerId } = access(req);
    const q = req.query as any;
    return suggestTags(db, ledgerId, q.fundId ? Number(q.fundId) : null, String(q.text ?? ''), q.kind === 'income' ? 'income' : 'expense', q.amount ? Number(q.amount) || null : null);
  });

  app.get(`${L}/tags/stats`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    return { ...tagStats(db, ledgerId, hiddenFundIds(db, ledgerId, userId, isAdmin)), currentYm: currentYm() };
  });

  app.patch(`${L}/tags/:tagId`, async (req) => {
    const { ledgerId } = access(req, true);
    const { name } = z.object({ name: z.string().trim().max(30, 'Тег длиннее 30 символов') }).parse(req.body);
    renameTag(db, ledgerId, Number((req.params as any).tagId), name);
    return { ok: true };
  });

  app.delete(`${L}/tags/:tagId`, async (req) => {
    const { ledgerId } = access(req, true);
    deleteTag(db, ledgerId, Number((req.params as any).tagId));
    return { ok: true };
  });

  /** Закрытый месяц меняет только администратор и только с согласием на пересчёт */
  function writable(ctx: { ledgerId: number; isAdmin: boolean }, date: string, recalc: boolean) {
    assertWritable(db, ctx.ledgerId, date, recalc && ctx.isAdmin);
  }

  function normalizeEntry(ctx: { ledgerId: number; userId: number; isAdmin: boolean }, body: z.infer<typeof EntryBody>) {
    if (body.kind === 'income') {
      if (!ctx.isAdmin) throw new DomainError('Доходы вносит администратор', 403);
      if (body.amount <= 0) throw new DomainError('Доход должен быть больше нуля.');
      const earnedBy = body.earnedBy ?? null;
      if (earnedBy !== null && !get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ctx.ledgerId, earnedBy)) {
        throw new DomainError('Участник не найден', 404);
      }
      return { ...body, fundId: null, paidBy: null, earnedBy, potId: null, refundOf: null };
    }
    if (body.potId && !get(db, `SELECT 1 x FROM pots WHERE id = ? AND ledger_id = ? AND kind = 'asset'`, body.potId, ctx.ledgerId)) {
      throw new DomainError('Актив не найден', 404);
    }
    // Расход по активу (агентские, нотариус) может идти без фонда: тогда он списывается прямо из свободных
    const assetOnly = !body.fundId && !!body.potId;
    if (!assetOnly && (!body.fundId || !get(db, 'SELECT 1 x FROM funds WHERE id = ? AND ledger_id = ?', body.fundId, ctx.ledgerId))) {
      throw new DomainError('Выбери фонд или актив.');
    }
    // Расход участника всегда копит долг базы перед ним; администратор может указать, кто платил
    let paidBy = ctx.isAdmin ? (body.paidBy ?? null) : ctx.userId;
    if (paidBy !== null && !get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ctx.ledgerId, paidBy)) {
      throw new DomainError('Участник не найден', 404);
    }
    return { ...body, fundId: assetOnly ? null : body.fundId, paidBy, earnedBy: null };
  }

  app.post(`${L}/entries`, async (req) => {
    const ctx = access(req);
    const body = EntryBody.parse(req.body);
    writable(ctx, body.date, body.recalc);
    const e = normalizeEntry(ctx, body);
    checkRefund(db, ctx, null, e.refundOf ?? null, e.kind, e.amount);
    const id = tx(db, () => {
      const entryId = Number(
        run(
          db,
          `INSERT INTO entries (ledger_id, date, kind, amount, fund_id, description, comment, paid_by, earned_by, pot_id, refund_of, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ctx.ledgerId,
          e.date,
          e.kind,
          e.amount,
          e.fundId,
          e.description,
          e.comment,
          e.paidBy,
          e.earnedBy,
          e.potId ?? null,
          e.refundOf ?? null,
          ctx.userId,
        ).lastInsertRowid,
      );
      setEntryTags(db, ctx.ledgerId, entryId, e.tags ?? []);
      if (touchesClosed(db, ctx.ledgerId, e.date)) logChange(db, ctx.ledgerId, ctx.userId, 'entry', entryId, 'create', null, snapshot(db, 'entry', entryId));
      noteEntries(db, ctx.ledgerId, ctx.userId, [entryId]);
      if (e.reminderId) {
        const done = run(db, `UPDATE reminders SET status = 'done', entry_id = ? WHERE id = ? AND ledger_id = ? AND user_id = ? AND status <> 'done' AND inactive_at IS NULL`, entryId, e.reminderId, ctx.ledgerId, ctx.userId);
        if (!done.changes) throw new DomainError('Платёж уже подтверждён или удалён', 409);
        scheduleNext(db, e.reminderId);
      }
      return entryId;
    });
    return { id };
  });

  /** Операция, которую этот человек может менять. Закрытый месяц проверяет вызывающий: не всякая правка задевает итоги */
  function ownedEntry(ctx: { ledgerId: number; userId: number; isAdmin: boolean }, id: number) {
    const entry = get<{ id: number; date: string; created_by: number; auto_credit: number }>(db, 'SELECT id, date, created_by, auto_credit FROM entries WHERE id = ? AND ledger_id = ? AND inactive_at IS NULL', id, ctx.ledgerId);
    if (!entry) throw new DomainError('Операция не найдена', 404);
    if (entry.auto_credit) throw new DomainError('Это начисление следует за планом фонда. Измени план или выключи начисление.');
    if (!ctx.isAdmin && entry.created_by !== ctx.userId) throw new DomainError('Можно менять только свои операции', 403);
    return entry;
  }

  app.put(`${L}/entries/:id`, async (req) => {
    const ctx = access(req);
    const id = Number((req.params as any).id);
    const body = EntryBody.parse(req.body);
    const old = ownedEntry(ctx, id);
    const e = normalizeEntry(ctx, body);
    const before = snapshot(db, 'entry', id) as EntryState;
    const potId = e.potId === undefined ? (before.potId ?? null) : e.potId;
    const refundOf = e.refundOf === undefined ? (before.refundOf ?? null) : e.refundOf;
    const after: EntryState = { ...before, date: e.date, kind: e.kind, amount: e.amount, fundId: e.fundId ?? null, paidBy: e.paidBy, earnedBy: e.earnedBy, potId, tags: e.tags ?? before.tags };
    // Описание, комментарий и привязку возврата можно поправить и в закрытом месяце без пересчёта: итоги от них не меняются
    if (affectsTotals(before, after)) {
      writable(ctx, old.date, body.recalc);
      writable(ctx, e.date, body.recalc);
    }
    checkRefund(db, ctx, id, refundOf, e.kind, e.amount);
    checkRefunded(db, ctx.ledgerId, id, e.kind, e.amount);
    tx(db, () => {
      run(
        db,
        'UPDATE entries SET date = ?, kind = ?, amount = ?, fund_id = ?, description = ?, comment = ?, paid_by = ?, earned_by = ?, pot_id = ?, refund_of = ? WHERE id = ?',
        e.date,
        e.kind,
        e.amount,
        e.fundId,
        e.description,
        e.comment,
        e.paidBy,
        e.earnedBy,
        potId,
        refundOf,
        id,
      );
      if (e.tags) setEntryTags(db, ctx.ledgerId, id, e.tags);
      if (touchesClosed(db, ctx.ledgerId, old.date, e.date)) {
        const now = snapshot(db, 'entry', id);
        if (JSON.stringify(now) !== JSON.stringify(before)) logChange(db, ctx.ledgerId, ctx.userId, 'entry', id, 'update', before, now);
      }
    });
    return { ok: true };
  });

  // Массовая правка отмеченных операций. Согласие на пересчёт закрытых месяцев спрашивается один раз на всю пачку,
  // каждая задетая операция закрытого месяца пишется в журнал отдельно, чтобы её можно было откатить
  app.post(`${L}/entries/bulk`, async (req) => {
    const ctx = access(req);
    const body = BulkBody.parse(req.body);
    const ids = [...new Set(body.ids)];
    const remove = new Set(normalizeTags(body.removeTags));
    const editing = body.addTags.length > 0 || remove.size > 0 || body.fundId !== undefined || body.comment !== undefined || body.amount !== undefined;
    if (!body.delete && !editing) throw new DomainError('Выбери, что изменить.');
    if (body.fundId !== undefined && !get(db, 'SELECT 1 x FROM funds WHERE id = ? AND ledger_id = ?', body.fundId, ctx.ledgerId)) throw new DomainError('Фонд не найден', 404);
    return tx(db, () => {
      const plan = ids.map((id) => {
        ownedEntry(ctx, id);
        const before = snapshot(db, 'entry', id) as EntryState;
        if (body.delete) return { id, before, after: null };
        const tags = normalizeTags([...before.tags.filter((t) => !remove.has(normalizeTag(t))), ...body.addTags]);
        if (tags.length > 10) throw new DomainError('Не больше 10 тегов у операции');
        // У дохода нет фонда, поэтому смена фонда его не трогает
        const after: EntryState = {
          ...before,
          fundId: before.kind === 'expense' && body.fundId !== undefined ? body.fundId : before.fundId,
          comment: body.comment ?? before.comment,
          amount: body.amount !== undefined ? Math.sign(before.amount) * body.amount : before.amount,
          tags: [...tags].sort().join() === [...before.tags].sort().join() ? before.tags : tags,
        };
        return { id, before, after };
      });
      const closed = [...new Set(plan.filter((p) => !p.after || affectsTotals(p.before, p.after)).map((p) => ymOf(p.before.date)))]
        .filter((ym) => isClosed(db, ctx.ledgerId, ym))
        .sort();
      if (closed.length && !ctx.isAdmin) throw new DomainError(`Операции закрытых месяцев (${closed.join(', ')}) может менять администратор.`, 403);
      if (closed.length && !body.recalc) {
        throw new DomainError(`${closed.length === 1 ? `Месяц ${closed[0]} закрыт` : `Месяцы ${closed.join(', ')} закрыты`}. Изменение пересчитает итоги этих и следующих месяцев.`, 409);
      }
      let changed = 0;
      for (const { id, before, after } of plan) {
        if (!after) {
          run(db, `UPDATE entries SET inactive_at = datetime('now') WHERE id = ?`, id);
        } else {
          if (JSON.stringify(after) === JSON.stringify(before)) continue;
          if (after.amount !== before.amount) {
            checkRefund(db, ctx, id, before.refundOf ?? null, after.kind, after.amount);
            checkRefunded(db, ctx.ledgerId, id, after.kind, after.amount);
          }
          run(db, 'UPDATE entries SET amount = ?, fund_id = ?, comment = ? WHERE id = ?', after.amount, after.fundId, after.comment, id);
          if (after.tags !== before.tags) setEntryTags(db, ctx.ledgerId, id, after.tags);
        }
        changed++;
        if (touchesClosed(db, ctx.ledgerId, before.date)) logChange(db, ctx.ledgerId, ctx.userId, 'entry', id, after ? 'update' : 'delete', before, after ? snapshot(db, 'entry', id) : null);
      }
      return { changed };
    });
  });

  app.delete(`${L}/entries/:id`, async (req) => {
    const ctx = access(req);
    const id = Number((req.params as any).id);
    const entry = ownedEntry(ctx, id);
    writable(ctx, entry.date, recalcQuery(req));
    tx(db, () => {
      const before = snapshot(db, 'entry', id);
      run(db, `UPDATE entries SET inactive_at = datetime('now') WHERE id = ?`, id);
      if (touchesClosed(db, ctx.ledgerId, entry.date)) logChange(db, ctx.ledgerId, ctx.userId, 'entry', id, 'delete', before, null);
    });
    return { ok: true };
  });

  app.get(`${L}/members`, async (req) => {
    const { ledgerId } = access(req);
    return all(
      db,
      `SELECT m.user_id userId, m.role, m.display_name name, m.emoji, m.hide_personal = 1 hidePersonal, m.notify = 1 notify,
         CASE WHEN m.user_id < 0 THEN NULL WHEN u.username IS NOT NULL THEN '@' || u.username ELSE u.name END account
       FROM members m JOIN users u ON u.id = m.user_id WHERE m.ledger_id = ? AND m.inactive_at IS NULL ORDER BY m.role, m.display_name`,
      ledgerId,
    );
  });

  app.patch(`${L}/members/:userId`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    const target = Number((req.params as any).userId);
    // Свои эмодзи и скрытие личных расходов участник меняет сам; всё остальное только администратор
    if (!isAdmin && (target !== userId || Object.keys(req.body as object).some((k) => k !== 'hidePersonal' && k !== 'emoji' && k !== 'notify'))) throw new DomainError('Это может только администратор', 403);
    const body = z.object({ name: Name.optional(), emoji: z.string().trim().max(16).optional(), role: z.enum(['admin', 'member']).optional(), settledUntil: Day.nullable().optional(), hidePersonal: z.boolean().optional(), notify: z.boolean().optional() }).parse(req.body);
    // Уведомления по базе каждый включает и выключает только себе
    if (body.notify !== undefined && target !== userId) throw new DomainError('Уведомления можно менять только себе.', 403);
    if (body.role === 'admin' && isVirtual(target)) throw new DomainError('Виртуальный участник не может быть администратором.');
    if (body.role === 'member' && target === userId) {
      const admins = get<{ c: number }>(db, `SELECT COUNT(*) c FROM members WHERE ledger_id = ? AND role = 'admin' AND inactive_at IS NULL`, ledgerId)!.c;
      if (admins < 2) throw new DomainError('В базе должен остаться хотя бы один администратор.');
    }
    if (body.name !== undefined) run(db, 'UPDATE members SET display_name = ? WHERE ledger_id = ? AND user_id = ?', body.name, ledgerId, target);
    if (body.emoji !== undefined) run(db, 'UPDATE members SET emoji = ? WHERE ledger_id = ? AND user_id = ?', body.emoji, ledgerId, target);
    if (body.role !== undefined) run(db, 'UPDATE members SET role = ? WHERE ledger_id = ? AND user_id = ?', body.role, ledgerId, target);
    if (body.hidePersonal !== undefined) run(db, 'UPDATE members SET hide_personal = ? WHERE ledger_id = ? AND user_id = ?', body.hidePersonal ? 1 : 0, ledgerId, target);
    if (body.settledUntil !== undefined) run(db, 'UPDATE members SET settled_until = ? WHERE ledger_id = ? AND user_id = ?', body.settledUntil, ledgerId, target);
    if (body.notify !== undefined) run(db, 'UPDATE members SET notify = ? WHERE ledger_id = ? AND user_id = ?', body.notify ? 1 : 0, ledgerId, target);
    return { ok: true };
  });

  // Выход из базы: что будет (долг, новый администратор) и сам выход. Профиль остаётся без аккаунта, см. leaveLedger
  app.get(`${L}/leave`, async (req) => {
    const { ledgerId, userId } = access(req);
    return leavePreview(db, ledgerId, userId);
  });

  app.post(`${L}/leave`, async (req) => {
    const { ledgerId, userId } = access(req);
    return { virtualId: tx(db, () => leaveLedger(db, ledgerId, userId)) };
  });

  app.delete(`${L}/members/:userId`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const target = Number((req.params as any).userId);
    if (target === userId) throw new DomainError('Нельзя удалить самого себя.');
    const debt = memberDebts(db, ledgerId).find((d) => d.userId === target);
    if (debt && debt.owed !== 0) throw new DomainError('Сначала закрой расчёты с этим участником.');
    run(db, `UPDATE members SET inactive_at = datetime('now') WHERE ledger_id = ? AND user_id = ?`, ledgerId, target);
    return { ok: true };
  });

  app.post(`${L}/members/virtual`, async (req) => {
    const { ledgerId } = access(req, true);
    const { name } = z.object({ name: Name }).parse(req.body);
    return { userId: tx(db, () => createVirtualMember(db, ledgerId, name)) };
  });

  app.post(`${L}/members/:userId/link-invite`, async (req) => {
    const { ledgerId } = access(req, true);
    const target = Number((req.params as any).userId);
    if (!isVirtual(target) || !get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, target)) {
      throw new DomainError('Виртуальный участник не найден', 404);
    }
    const token = randomBytes(16).toString('hex');
    run(db, 'INSERT INTO invites (token, ledger_id, expires_at, virtual_user_id) VALUES (?, ?, ?, ?)', token, ledgerId, Date.now() + INVITE_TTL_MS, target);
    return { token, link: inviteLink(token) };
  });

  app.post(`${L}/members/:userId/link`, async (req) => {
    const { ledgerId } = access(req, true);
    const { userId: realId } = z.object({ userId: z.number().int() }).parse(req.body);
    if (!get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, realId)) throw new DomainError('Участник не найден', 404);
    tx(db, () => mergeVirtualMember(db, ledgerId, Number((req.params as any).userId), realId));
    return { ok: true };
  });

  app.post(`${L}/invites`, async (req) => {
    const { ledgerId } = access(req, true);
    const token = randomBytes(16).toString('hex');
    run(db, 'INSERT INTO invites (token, ledger_id, expires_at) VALUES (?, ?, ?)', token, ledgerId, Date.now() + INVITE_TTL_MS);
    return { token, link: inviteLink(token) };
  });

  app.get(`${L}/settlements`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    return all(
      db,
      `SELECT s.id, s.user_id userId, m.display_name name, s.date, s.amount, s.comment
       FROM settlements s LEFT JOIN members m ON m.ledger_id = s.ledger_id AND m.user_id = s.user_id
       WHERE s.ledger_id = ? AND s.inactive_at IS NULL AND (? = 1 OR s.user_id = ?) ORDER BY s.date DESC, s.id DESC LIMIT 100`,
      ledgerId,
      isAdmin ? 1 : 0,
      userId,
    );
  });

  app.post(`${L}/settlements`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const body = z.object({ userId: z.number().int(), date: Day, amount: Money.positive(), comment: Comment, settledUntil: Day.optional() }).parse(req.body);
    if (!get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, body.userId)) throw new DomainError('Участник не найден', 404);
    if (body.settledUntil) run(db, 'UPDATE members SET settled_until = ? WHERE ledger_id = ? AND user_id = ?', body.settledUntil, ledgerId, body.userId);
    const id = run(
      db,
      'INSERT INTO settlements (ledger_id, user_id, date, amount, comment, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      ledgerId,
      body.userId,
      body.date,
      body.amount,
      body.comment,
      userId,
    ).lastInsertRowid;
    noteSettlement(db, ledgerId, userId, Number(id), body.userId);
    return { id: Number(id) };
  });

  // Запланированные платежи: каждый видит и меняет свои
  app.get(`${L}/reminders`, async (req) => {
    const { ledgerId, userId } = access(req);
    return all(
      db,
      `SELECT r.id, r.comment, r.amount, r.fund_id fundId, f.name fundName, r.due_date dueDate, r.due_time dueTime, r.remind_at remindAt, r.status, r.repeat, r.anchor_day anchorDay
       FROM reminders r LEFT JOIN funds f ON f.id = r.fund_id
       WHERE r.ledger_id = ? AND r.user_id = ? AND r.inactive_at IS NULL AND r.status <> 'done' ORDER BY r.due_date, r.remind_at`,
      ledgerId,
      userId,
    );
  });

  function reminderFund(ledgerId: number, fundId: number | null) {
    if (fundId !== null && !get(db, 'SELECT 1 x FROM funds WHERE id = ? AND ledger_id = ?', fundId, ledgerId)) throw new DomainError('Фонд не найден', 404);
  }

  app.post(`${L}/reminders`, async (req) => {
    const { ledgerId, userId } = access(req);
    const body = ReminderBody.parse(req.body);
    reminderFund(ledgerId, body.fundId);
    const s = seriesFields(body.dueDate, body.remindAt, body.anchorDay);
    const id = run(
      db,
      `INSERT INTO reminders (ledger_id, user_id, comment, amount, fund_id, due_date, due_time, remind_at, repeat, series_due, remind_offset, anchor_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ledgerId, userId, body.comment, body.amount, body.fundId, body.dueDate, body.dueTime, body.remindAt, body.repeat, s.seriesDue, s.remindOffset, s.anchorDay,
    ).lastInsertRowid;
    return { id: Number(id) };
  });

  // Перенос и правка: напоминание снова ждёт своего часа; у повторяющегося платежа новые даты задают и дальнейшие разы
  app.put(`${L}/reminders/:id`, async (req) => {
    const { ledgerId, userId } = access(req);
    const body = ReminderBody.parse(req.body);
    reminderFund(ledgerId, body.fundId);
    const res = run(
      db,
      `UPDATE reminders SET comment = ?, amount = ?, fund_id = ?, due_date = ?, remind_at = ?, repeat = ?, series_due = ?, remind_offset = ?, anchor_day = ?, due_time = ?,
         status = CASE WHEN ? > ? THEN 'scheduled' ELSE status END
       WHERE id = ? AND ledger_id = ? AND user_id = ? AND status <> 'done' AND inactive_at IS NULL`,
      body.comment, body.amount, body.fundId, body.dueDate, body.remindAt, body.repeat, ...Object.values(seriesFields(body.dueDate, body.remindAt, body.anchorDay)), body.dueTime,
      body.remindAt, Date.now(), Number((req.params as any).id), ledgerId, userId,
    );
    if (!res.changes) throw new DomainError('Платёж не найден', 404);
    return { ok: true };
  });

  // Пропустить один раз повторяющегося платежа
  app.post(`${L}/reminders/:id/skip`, async (req) => {
    const { ledgerId, userId } = access(req);
    const id = Number((req.params as any).id);
    if (!get(db, `SELECT 1 x FROM reminders WHERE id = ? AND ledger_id = ? AND user_id = ? AND status <> 'done' AND inactive_at IS NULL`, id, ledgerId, userId)) throw new DomainError('Платёж не найден', 404);
    skipReminder(db, id);
    return { ok: true };
  });

  app.delete(`${L}/reminders/:id`, async (req) => {
    const { ledgerId, userId } = access(req);
    run(db, `UPDATE reminders SET inactive_at = datetime('now') WHERE id = ? AND ledger_id = ? AND user_id = ? AND inactive_at IS NULL`, Number((req.params as any).id), ledgerId, userId);
    return { ok: true };
  });

  app.delete(`${L}/settlements/:id`, async (req) => {
    const { ledgerId } = access(req, true);
    run(db, `UPDATE settlements SET inactive_at = datetime('now') WHERE id = ? AND ledger_id = ? AND inactive_at IS NULL`, Number((req.params as any).id), ledgerId);
    return { ok: true };
  });

  app.get(`${L}/adjustments`, async (req) => {
    const { ledgerId } = access(req);
    return all<{ tags: string; closed: number }>(
      db,
      `SELECT a.id, a.date, a.amount, a.comment,
         EXISTS (SELECT 1 FROM closed_months c WHERE c.ledger_id = a.ledger_id AND c.ym = substr(a.date, 1, 7)) closed,
         (SELECT json_group_array(t.name) FROM adjustment_tags at JOIN tags t ON t.id = at.tag_id AND t.inactive_at IS NULL WHERE at.adjustment_id = a.id) tags
       FROM adjustments a WHERE a.ledger_id = ? AND a.inactive_at IS NULL ORDER BY a.date DESC, a.id DESC`,
      ledgerId,
    ).map((a) => ({ ...a, closed: !!a.closed, tags: JSON.parse(a.tags) as string[] }));
  });

  app.post(`${L}/adjustments`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const body = AdjustmentBody.parse(req.body);
    assertWritable(db, ledgerId, body.date, body.recalc);
    const id = tx(db, () => {
      const id = Number(run(db, 'INSERT INTO adjustments (ledger_id, date, amount, comment) VALUES (?, ?, ?, ?)', ledgerId, body.date, body.amount, body.comment).lastInsertRowid);
      setAdjustmentTags(db, ledgerId, id, body.tags);
      if (touchesClosed(db, ledgerId, body.date)) logChange(db, ledgerId, userId, 'adjustment', id, 'create', null, snapshot(db, 'adjustment', id));
      return id;
    });
    return { id };
  });

  // Описание и теги на итоги не влияют, поэтому их можно менять и в закрытом месяце без согласия на пересчёт
  app.put(`${L}/adjustments/:id`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const id = Number((req.params as any).id);
    const row = get<{ date: string; amount: number }>(db, 'SELECT date, amount FROM adjustments WHERE id = ? AND ledger_id = ? AND inactive_at IS NULL', id, ledgerId);
    if (!row) throw new DomainError('Запись не найдена', 404);
    const body = AdjustmentBody.parse(req.body);
    if (body.date !== row.date || body.amount !== row.amount) {
      assertWritable(db, ledgerId, row.date, body.recalc);
      assertWritable(db, ledgerId, body.date, body.recalc);
    }
    const affectsTotals = body.date !== row.date || body.amount !== row.amount;
    tx(db, () => {
      const before = snapshot(db, 'adjustment', id);
      run(db, 'UPDATE adjustments SET date = ?, amount = ?, comment = ? WHERE id = ?', body.date, body.amount, body.comment, id);
      setAdjustmentTags(db, ledgerId, id, body.tags);
      if (affectsTotals && touchesClosed(db, ledgerId, row.date, body.date)) logChange(db, ledgerId, userId, 'adjustment', id, 'update', before, snapshot(db, 'adjustment', id));
    });
    return { ok: true };
  });

  app.delete(`${L}/adjustments/:id`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const id = Number((req.params as any).id);
    const row = get<{ date: string }>(db, 'SELECT date FROM adjustments WHERE id = ? AND ledger_id = ? AND inactive_at IS NULL', id, ledgerId);
    if (!row) throw new DomainError('Запись не найдена', 404);
    assertWritable(db, ledgerId, row.date, recalcQuery(req));
    tx(db, () => {
      const before = snapshot(db, 'adjustment', id);
      run(db, `UPDATE adjustments SET inactive_at = datetime('now') WHERE id = ?`, id);
      if (touchesClosed(db, ledgerId, row.date)) logChange(db, ledgerId, userId, 'adjustment', id, 'delete', before, null);
    });
    return { ok: true };
  });

  app.get(`${L}/changes`, async (req) => {
    const { ledgerId } = access(req, true);
    return listChanges(db, ledgerId);
  });

  app.post(`${L}/changes/:changeId/revert`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    tx(db, () => revertChange(db, ledgerId, userId, Number((req.params as any).changeId)));
    return { ok: true };
  });

  app.get(`${L}/pots`, async (req) => {
    const { ledgerId } = access(req);
    return valuePots(db, ledgerId);
  });

  app.post(`${L}/pots`, async (req) => {
    const { ledgerId } = access(req, true);
    const body = z
      .object({
        name: Name,
        kind: z.enum(['cash', 'currency', 'stock', 'asset']).optional(),
        currency: z.string().trim().length(3).toUpperCase().optional(),
        ticker: z.string().trim().toUpperCase().regex(/^[A-Z0-9.\-^=]{1,15}$/, 'Проверь тикер').optional(),
        openingBalance: Money.default(0),
        openingUnits: z.number().finite().default(0),
      })
      .parse(req.body);
    if (get(db, 'SELECT 1 x FROM pots WHERE ledger_id = ? AND name = ?', ledgerId, body.name)) throw new DomainError('Такая копилка уже есть.');
    const base = get<{ currency: string }>(db, 'SELECT currency FROM ledgers WHERE id = ?', ledgerId)!.currency;
    const kind = body.kind ?? (body.currency && body.currency !== base ? 'currency' : 'cash');
    let currency = base;
    let ticker: string | null = null;
    if (kind === 'currency') {
      if (!body.currency || body.currency === base) throw new DomainError('Выбери валюту, отличную от основной.');
      currency = body.currency;
    }
    if (kind === 'stock') {
      if (!body.ticker) throw new DomainError('Укажи тикер акции.');
      if (!options.market) throw new DomainError('Котировки недоступны.');
      ticker = body.ticker;
      const quote = await options.market.quote(ticker).catch(() => {
        throw new DomainError('Не удалось получить котировку. Попробуй позже.', 502);
      });
      if (!quote) throw new DomainError(`Тикер ${ticker} не найден.`);
      saveQuote(db, ticker, quote, new Date().toISOString().slice(0, 10));
      currency = quote.currency;
    }
    // Актив есть или его нет: уже имеющийся заводится одной единицей по стоимости на старт
    const openingUnits = kind === 'asset' ? (body.openingBalance > 0 ? 1 : 0) : body.openingUnits;
    const id = run(
      db,
      'INSERT INTO pots (ledger_id, name, kind, currency, ticker, opening_balance, opening_units) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ledgerId,
      body.name,
      kind,
      currency,
      ticker,
      body.openingBalance,
      openingUnits,
    ).lastInsertRowid;
    if ((kind === 'currency' || kind === 'stock') && options.market) void backfillPotPrices(db, options.market, new Date().toISOString().slice(0, 10));
    return { id: Number(id) };
  });

  app.get(`${L}/pots/:potId/quotes`, async (req) => {
    const { ledgerId } = access(req);
    const potId = Number((req.params as any).potId);
    if (!get(db, 'SELECT 1 x FROM pots WHERE id = ? AND ledger_id = ?', potId, ledgerId)) throw new DomainError('Копилка не найдена', 404);
    if (!options.market) throw new DomainError('Котировки недоступны.', 503);
    try {
      return await potQuotes(db, options.market, potId, new Date().toISOString().slice(0, 10));
    } catch {
      throw new DomainError('Не удалось загрузить котировки. Попробуй позже.', 502);
    }
  });

  const potOf = (ledgerId: number, potId: number) => {
    const pot = get<{ kind: string; currency: string }>(db, 'SELECT kind, currency FROM pots WHERE id = ? AND ledger_id = ?', potId, ledgerId);
    if (!pot) throw new DomainError('Вклад не найден', 404);
    return pot;
  };

  /** Актив либо есть (1), либо нет (0): сделки по порядку дат не должны уводить количество за эти границы. */
  const assertAssetUnits = (potId: number) => {
    const opening = get<{ u: number }>(db, 'SELECT opening_units u FROM pots WHERE id = ?', potId)!.u;
    let units = opening;
    for (const m of all<{ units: number }>(db, 'SELECT units FROM pot_moves WHERE pot_id = ? AND inactive_at IS NULL ORDER BY date, id', potId)) {
      units += m.units;
      if (units < 0 || units > 1) throw new DomainError('Так не выйдет: актив окажется продан раньше покупки или куплен дважды. Проверь даты сделок.');
    }
  };

  const MoveBody = z.object({ date: Day, amount: Money.refine((v) => v !== 0, 'Сумма не может быть нулевой'), units: z.number().finite().default(0), comment: Comment, recalc: z.boolean().default(false) });

  app.post(`${L}/pots/:potId/moves`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const potId = Number((req.params as any).potId);
    const body = MoveBody.parse(req.body);
    const pot = potOf(ledgerId, potId);
    assertWritable(db, ledgerId, body.date, body.recalc);
    return tx(db, () => {
      let units = body.units;
      if (pot.kind === 'asset') {
        // Сделка с активом: покупка делает его своим, следующие вложения (ремонт, доплата) только добавляют к уплаченному,
        // продажа отдаёт целиком. Количество считается на дату сделки
        const held = get<{ u: number }>(
          db,
          'SELECT opening_units + COALESCE((SELECT SUM(m.units) FROM pot_moves m WHERE m.pot_id = pots.id AND m.inactive_at IS NULL AND m.date <= ?), 0) u FROM pots WHERE id = ?',
          body.date,
          potId,
        )!.u;
        if (body.amount > 0) units = held > 0 ? 0 : 1;
        else if (held > 0) units = -held;
        else throw new DomainError('На эту дату актива нет: продавать нечего.');
      }
      const id = Number(run(db, 'INSERT INTO pot_moves (pot_id, date, amount, units, comment) VALUES (?, ?, ?, ?, ?)', potId, body.date, body.amount, units, body.comment).lastInsertRowid);
      if (pot.kind === 'asset') assertAssetUnits(potId);
      if (touchesClosed(db, ledgerId, body.date)) logChange(db, ledgerId, userId, 'pot_move', id, 'create', null, snapshot(db, 'pot_move', id));
      return { id };
    });
  });

  // Покупка или продажа акций по тикеру: количество и цена за штуку в валюте акции. Вклад под тикер заводится сам,
  // сумма в основной валюте считается по курсу на дату сделки, а без него по последнему
  // Курс сделки: Нацбанк на дату, а если его нет, последний известный
  async function tradeRate(currency: string, base: string, date: string) {
    if (currency === base) return { rate: 1, onDate: 1 };
    if (options.market) await ensureRatesOn(db, options.market, date);
    const onDate = rateOn(db, currency, base, date);
    const rate = onDate ?? convert(db, 1, currency, base)?.rate ?? null;
    if (rate === null) throw new DomainError(`Нет курса ${currency} к ${base}.`);
    return { rate, onDate };
  }

  app.post(`${L}/stocks/trade`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const body = z
      .object({
        ticker: z.string().trim().toUpperCase().regex(/^[A-Z0-9.\-^=]{1,15}$/, 'Проверь тикер'),
        side: z.enum(['buy', 'sell']),
        units: z.number().finite().positive('Укажи количество'),
        price: z.number().finite().positive('Укажи цену за штуку'),
        // Цена может быть в валюте акции или в основной валюте базы (брокер в тенге)
        priceIn: z.enum(['stock', 'base']).default('stock'),
        // Цена сильно отличается от котировки, человек подтвердил, что это не ошибка
        priceChecked: z.boolean().default(false),
        date: Day,
        comment: Comment.optional(),
        recalc: z.boolean().default(false),
      })
      .parse(req.body);
    assertWritable(db, ledgerId, body.date, body.recalc);
    const base = get<{ currency: string }>(db, 'SELECT currency FROM ledgers WHERE id = ?', ledgerId)!.currency;
    let pot = get<{ id: number; currency: string }>(db, `SELECT id, currency FROM pots WHERE ledger_id = ? AND kind = 'stock' AND ticker = ? ORDER BY id LIMIT 1`, ledgerId, body.ticker);
    if (!pot && body.side === 'sell') throw new DomainError(`Акций ${body.ticker} в портфеле нет.`);
    let currency = pot?.currency ?? '';
    if (!pot) {
      if (!options.market) throw new DomainError('Котировки недоступны.');
      const quote = await options.market.quote(body.ticker).catch(() => {
        throw new DomainError('Не удалось получить котировку. Попробуй позже.', 502);
      });
      if (!quote) throw new DomainError(`Тикер ${body.ticker} не найден.`);
      saveQuote(db, body.ticker, quote, new Date().toISOString().slice(0, 10));
      currency = quote.currency;
    }
    const { rate, onDate } = await tradeRate(currency, base, body.date);
    const sign = body.side === 'buy' ? 1 : -1;
    const inBase = body.priceIn === 'base' && currency !== base;
    const amount = sign * Math.round(body.units * body.price * (inBase ? 1 : rate) * 100);
    if (amount === 0) throw new DomainError('Сумма сделки получилась нулевой.');
    // Защита от цены не в той валюте: 26 636 ₸ вместо 59,33 $ даёт вложение в 450 раз больше
    const quoted = get<{ price: number }>(db, 'SELECT price FROM quotes WHERE ticker = ? AND currency = ?', body.ticker, currency)?.price;
    const perUnit = inBase ? body.price / rate : body.price;
    if (quoted && !body.priceChecked && (perUnit > quoted * 3 || perUnit < quoted / 3)) {
      throw new DomainError(
        `Цена ${body.price} ${inBase ? base : currency} за штуку сильно отличается от котировки ${body.ticker}: ${quoted} ${currency}${currency !== base ? ` (≈ ${Math.round(quoted * rate)} ${base})` : ''}. Проверь валюту цены.`,
        422,
      );
    }
    const shown = `${body.units} × ${body.price} ${inBase ? base : currency}${currency !== base ? `, курс ${Math.round(rate * 100) / 100}${onDate === null ? ' (последний)' : ''}` : ''}`;
    return tx(db, () => {
      if (!pot) {
        // Название по тикеру; если такое занято другим вкладом, добавляется пометка
        const name = get(db, 'SELECT 1 x FROM pots WHERE ledger_id = ? AND name = ?', ledgerId, body.ticker) ? `${body.ticker} (акции)` : body.ticker;
        const id = Number(run(db, `INSERT INTO pots (ledger_id, name, kind, currency, ticker, opening_balance, opening_units) VALUES (?, ?, 'stock', ?, ?, 0, 0)`, ledgerId, name, currency, body.ticker).lastInsertRowid);
        pot = { id, currency };
      }
      if (body.side === 'sell') {
        const held = get<{ u: number }>(
          db,
          'SELECT opening_units + COALESCE((SELECT SUM(m.units) FROM pot_moves m WHERE m.pot_id = pots.id AND m.inactive_at IS NULL AND m.date <= ?), 0) u FROM pots WHERE id = ?',
          body.date,
          pot.id,
        )!.u;
        if (held + 1e-9 < body.units) throw new DomainError(`На эту дату ${body.ticker} только ${held} шт.`);
      }
      const id = Number(run(db, 'INSERT INTO pot_moves (pot_id, date, amount, units, comment) VALUES (?, ?, ?, ?, ?)', pot.id, body.date, amount, sign * body.units, body.comment?.trim() || shown).lastInsertRowid);
      if (touchesClosed(db, ledgerId, body.date)) logChange(db, ledgerId, userId, 'pot_move', id, 'create', null, snapshot(db, 'pot_move', id));
      return { potId: pot.id, id, amount, rate };
    });
  });

  // Правка сделки: дата, сумма, комментарий. У актива покупка остаётся покупкой, продажа продажей
  app.put(`${L}/pots/:potId/moves/:moveId`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const potId = Number((req.params as any).potId);
    const moveId = Number((req.params as any).moveId);
    const pot = potOf(ledgerId, potId);
    const body = MoveBody.extend({
      // Для акций можно указать цену за штуку: сумма посчитается по ней (в валюте акции по курсу на дату или сразу в основной)
      price: z.number().finite().positive('Проверь цену за штуку').optional(),
      priceIn: z.enum(['stock', 'base']).default('stock'),
    }).parse(req.body);
    const row = get<{ date: string; amount: number; units: number }>(db, 'SELECT date, amount, units FROM pot_moves WHERE id = ? AND pot_id = ? AND inactive_at IS NULL', moveId, potId);
    if (!row) throw new DomainError('Сделка не найдена', 404);
    if (body.price !== undefined) {
      if (pot.kind !== 'stock') throw new DomainError('Цена за штуку бывает только у акций.');
      if (!body.units) throw new DomainError('Укажи количество акций.');
      const base = get<{ currency: string }>(db, 'SELECT currency FROM ledgers WHERE id = ?', ledgerId)!.currency;
      const { rate } = body.priceIn === 'base' ? { rate: 1 } : await tradeRate(pot.currency, base, body.date);
      body.amount = Math.sign(body.amount) * Math.round(Math.abs(body.units) * body.price * rate * 100);
      if (body.amount === 0) throw new DomainError('Сумма сделки получилась нулевой.');
    }
    const units = pot.kind === 'asset' ? row.units : body.units;
    if (pot.kind === 'asset' && Math.sign(body.amount) !== Math.sign(row.amount)) throw new DomainError('Покупку нельзя превратить в продажу и наоборот: убери сделку и добавь новую.');
    const changed = body.date !== row.date || body.amount !== row.amount || units !== row.units;
    if (changed) {
      assertWritable(db, ledgerId, row.date, body.recalc);
      assertWritable(db, ledgerId, body.date, body.recalc);
    }
    tx(db, () => {
      const before = snapshot(db, 'pot_move', moveId);
      run(db, 'UPDATE pot_moves SET date = ?, amount = ?, units = ?, comment = ? WHERE id = ?', body.date, body.amount, units, body.comment, moveId);
      if (pot.kind === 'asset') assertAssetUnits(potId);
      if (changed && touchesClosed(db, ledgerId, row.date, body.date)) logChange(db, ledgerId, userId, 'pot_move', moveId, 'update', before, snapshot(db, 'pot_move', moveId));
    });
    return { ok: true };
  });

  app.delete(`${L}/pots/:potId/moves/:moveId`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const potId = Number((req.params as any).potId);
    const moveId = Number((req.params as any).moveId);
    const pot = potOf(ledgerId, potId);
    const row = get<{ date: string }>(db, 'SELECT date FROM pot_moves WHERE id = ? AND pot_id = ? AND inactive_at IS NULL', moveId, potId);
    if (!row) throw new DomainError('Сделка не найдена', 404);
    assertWritable(db, ledgerId, row.date, recalcQuery(req));
    tx(db, () => {
      const before = snapshot(db, 'pot_move', moveId);
      run(db, `UPDATE pot_moves SET inactive_at = datetime('now') WHERE id = ?`, moveId);
      if (pot.kind === 'asset') assertAssetUnits(potId);
      if (touchesClosed(db, ledgerId, row.date)) logChange(db, ledgerId, userId, 'pot_move', moveId, 'delete', before, null);
    });
    return { ok: true };
  });

  // Название вклада на суммы не влияет, поэтому меняется в любой момент
  app.patch(`${L}/pots/:potId`, async (req) => {
    const { ledgerId } = access(req, true);
    const potId = Number((req.params as any).potId);
    potOf(ledgerId, potId);
    const { name } = z.object({ name: Name }).parse(req.body);
    if (get(db, 'SELECT 1 x FROM pots WHERE ledger_id = ? AND name = ? AND id != ?', ledgerId, name, potId)) throw new DomainError('Вклад с таким названием уже есть.');
    run(db, 'UPDATE pots SET name = ? WHERE id = ?', name, potId);
    return { ok: true };
  });

  const assetOf = (ledgerId: number, potId: number) => {
    if (!get(db, `SELECT 1 x FROM pots WHERE id = ? AND ledger_id = ? AND kind = 'asset'`, potId, ledgerId)) throw new DomainError('Актив не найден', 404);
  };

  // Сопутствующие расходы актива: обычные расходы фондов, привязанные к нему; на стоимость актива не влияют
  app.get(`${L}/pots/:potId/expenses`, async (req) => {
    const { ledgerId } = access(req);
    const potId = Number((req.params as any).potId);
    return all(
      db,
      `SELECT e.id, e.date, e.amount, e.comment, e.description, f.name fundName FROM entries e LEFT JOIN funds f ON f.id = e.fund_id
       WHERE e.ledger_id = ? AND e.pot_id = ? AND e.inactive_at IS NULL ORDER BY e.date, e.id`,
      ledgerId,
      potId,
    );
  });

  app.get(`${L}/pots/:potId/values`, async (req) => {
    const { ledgerId } = access(req);
    const potId = Number((req.params as any).potId);
    assetOf(ledgerId, potId);
    return all(
      db,
      `SELECT v.id, v.date, v.value, v.comment, v.created_at createdAt, COALESCE(m.display_name, u.name) userName
       FROM asset_values v LEFT JOIN members m ON m.ledger_id = ? AND m.user_id = v.created_by LEFT JOIN users u ON u.id = v.created_by
       WHERE v.pot_id = ? AND v.inactive_at IS NULL ORDER BY v.date DESC, v.id DESC`,
      ledgerId,
      potId,
    );
  });

  // Оценка не правится: новая добавляется поверх, ошибочную можно убрать, а в закрытом месяце обе попадают в журнал
  app.post(`${L}/pots/:potId/values`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const potId = Number((req.params as any).potId);
    assetOf(ledgerId, potId);
    const body = z.object({ date: Day, value: Money.refine((v) => v >= 0, 'Стоимость не может быть отрицательной'), comment: Comment, recalc: z.boolean().default(false) }).parse(req.body);
    if (body.date > new Date().toISOString().slice(0, 10)) throw new DomainError('Оценка не может быть в будущем.');
    assertWritable(db, ledgerId, body.date, body.recalc);
    const id = tx(db, () => {
      const id = Number(run(db, 'INSERT INTO asset_values (pot_id, date, value, comment, created_by) VALUES (?, ?, ?, ?, ?)', potId, body.date, body.value, body.comment, userId).lastInsertRowid);
      if (touchesClosed(db, ledgerId, body.date)) logChange(db, ledgerId, userId, 'asset_value', id, 'create', null, snapshot(db, 'asset_value', id));
      return id;
    });
    return { id };
  });

  app.delete(`${L}/pots/:potId/values/:id`, async (req) => {
    const { ledgerId, userId } = access(req, true);
    const potId = Number((req.params as any).potId);
    const id = Number((req.params as any).id);
    assetOf(ledgerId, potId);
    const row = get<{ date: string }>(db, 'SELECT date FROM asset_values WHERE id = ? AND pot_id = ? AND inactive_at IS NULL', id, potId);
    if (!row) throw new DomainError('Оценка не найдена', 404);
    assertWritable(db, ledgerId, row.date, recalcQuery(req));
    tx(db, () => {
      const before = snapshot(db, 'asset_value', id);
      run(db, `UPDATE asset_values SET inactive_at = datetime('now') WHERE id = ?`, id);
      if (touchesClosed(db, ledgerId, row.date)) logChange(db, ledgerId, userId, 'asset_value', id, 'delete', before, null);
    });
    return { ok: true };
  });

  app.get(`${L}/imports`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    const list = listOpenImports(db, ledgerId) as any[];
    if (isAdmin) return list;
    const own = new Set(all<{ id: number }>(db, 'SELECT id FROM import_batches WHERE ledger_id = ? AND user_id = ?', ledgerId, userId).map((b) => b.id));
    return list.filter((b) => own.has(b.id));
  });

  app.post(`${L}/imports`, async (req) => {
    const { ledgerId, userId } = access(req);
    const files: UploadedFile[] = [];
    for await (const part of req.files()) {
      const data = await part.toBuffer();
      files.push({ name: part.filename || 'выписка.pdf', data: new Uint8Array(data) });
    }
    if (!files.length) throw new DomainError('Прикрепи файл выписки.');
    const id = await createImport(db, suggestFunds, ledgerId, userId, files, options.market);
    return { id };
  });

  // Выписки, присланные боту и ждущие обработки
  app.get(`${L}/queue`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    return listQueue(db, ledgerId, userId, isAdmin);
  });

  app.post(`${L}/queue/process`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    return { id: await processQueue(db, suggestFunds, ledgerId, userId, isAdmin, options.market) };
  });

  app.delete(`${L}/queue/:id`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    removeQueued(db, ledgerId, Number((req.params as any).id), userId, isAdmin);
    return { ok: true };
  });

  app.get(`${L}/imports/:id`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    const batch = getImport(db, ledgerId, Number((req.params as any).id));
    if (!isAdmin && batch.userId !== userId) throw new DomainError('Это выписка другого участника', 403);
    return batch;
  });

  app.put(`${L}/imports/:id/draft`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    const { draft } = z.object({ draft: z.record(z.string(), z.unknown()) }).parse(req.body);
    saveDraft(db, ledgerId, Number((req.params as any).id), { userId, isAdmin }, draft);
    return { ok: true };
  });

  app.get(`${L}/imports/sent`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    return listSentImports(db, ledgerId, { userId, isAdmin });
  });

  // Отмена отправки: операции выписки снимаются из учёта, выписка снова ждёт проверки
  app.post(`${L}/imports/:id/revert`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    const { recalc } = z.object({ recalc: z.boolean().default(false) }).parse(req.body ?? {});
    return revertImport(db, ledgerId, Number((req.params as any).id), { userId, isAdmin }, recalc);
  });

  app.get(`${L}/incomes/category-options`, async (req) => {
    const { ledgerId } = access(req);
    return incomeCategoryOptions(db, ledgerId);
  });

  app.post(`${L}/imports/:id/decide`, async (req) => {
    const { ledgerId, userId, isAdmin } = access(req);
    const { decisions } = DecisionsBody.parse(req.body);
    return applyDecisions(db, ledgerId, Number((req.params as any).id), { userId, isAdmin }, decisions);
  });

  if (options.webDist && existsSync(options.webDist)) {
    app.register(fastifyStatic, { root: options.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Не найдено' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

export { ymOf };
