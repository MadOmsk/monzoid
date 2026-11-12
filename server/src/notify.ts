import { all, get, run, type Db } from './db.js';
import { memberDebts } from './domain.js';

/** Тишина после последней операции человека, после которой уведомления уходят пакетом. */
export const BATCH_QUIET_MS = 10 * 60 * 1000;

/** screen: какой экран открыть по кнопке «Открыть Monzoid» под сообщением. */
export interface Notice { chatId: number; text: string; ledgerId: number; screen: 'settle' | 'entries'; /** Напоминание о платеже: под сообщением кнопки переноса и удаления */ reminderId?: number; repeating?: boolean }
export type Send = (notice: Notice) => Promise<void>;

const SYMBOLS: Record<string, string> = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€' };

function money(tiyn: number, currency: string): string {
  const value = Math.round(Math.abs(tiyn) / 100).toLocaleString('ru-RU').replace(/ /g, ' ');
  return `${value} ${SYMBOLS[currency] ?? currency}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

/** Виртуальные участники не входят в Telegram, а выключившие уведомления их не получают: совсем или только по этой базе. */
function canNotify(db: Db, userId: number, ledgerId: number): boolean {
  if (userId <= 0) return false;
  return !!get(db, 'SELECT 1 x FROM users WHERE id = ? AND notify = 1', userId) && ledgerNotify(db, userId, ledgerId);
}

/** Уведомления по базе включены у действующего участника. */
function ledgerNotify(db: Db, userId: number, ledgerId: number): boolean {
  return !!get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL AND notify = 1', ledgerId, userId);
}

/**
 * Новые операции: администратор внёс за другого участника (оплатил или заработал он), то уведомление ему;
 * участник внёс сам, то администраторам. Уведомления копятся и уходят пакетом после тишины.
 */
export function noteEntries(db: Db, ledgerId: number, actorId: number, entryIds: number[]): void {
  if (!entryIds.length) return;
  const actor = get<{ role: string }>(db, 'SELECT role FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, actorId);
  if (!actor) return;
  const admins = actor.role === 'admin'
    ? []
    : all<{ user_id: number }>(db, `SELECT user_id FROM members WHERE ledger_id = ? AND role = 'admin' AND inactive_at IS NULL AND user_id <> ?`, ledgerId, actorId).map((r) => r.user_id);
  const now = Date.now();
  for (const id of entryIds) {
    const entry = get<{ paid_by: number | null; earned_by: number | null }>(db, 'SELECT paid_by, earned_by FROM entries WHERE id = ?', id);
    if (!entry) continue;
    const owner = entry.paid_by ?? entry.earned_by;
    const recipients = actor.role === 'admin' ? (owner !== null && owner !== actorId ? [owner] : []) : admins;
    for (const to of recipients) {
      if (canNotify(db, to, ledgerId)) run(db, `INSERT INTO notices (ledger_id, recipient_id, actor_id, kind, ref_id, created_at) VALUES (?, ?, ?, 'entry', ?, ?)`, ledgerId, to, actorId, id, now);
    }
  }
}

export type Repeat = 'week' | 'month';

/** Плановые поля серии из даты оплаты и момента напоминания. */
export function seriesFields(dueDate: string, remindAt: number, anchorDay?: number) {
  return { seriesDue: dueDate, remindOffset: remindAt - Date.parse(`${dueDate}T00:00:00Z`), anchorDay: anchorDay ?? Number(dueDate.slice(8, 10)) };
}

function nextDue(due: string, repeat: Repeat, anchorDay: number): string {
  const [y, m, d] = due.split('-').map(Number);
  if (repeat === 'week') return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchorDay, last))).toISOString().slice(0, 10);
}

/** Повторяющийся платёж: после подтверждения или пропуска ставит следующий раз по плановой дате, а не по перенесённой. */
export function scheduleNext(db: Db, reminderId: number): void {
  const r = get<{ ledger_id: number; user_id: number; comment: string; amount: number | null; fund_id: number | null; repeat: Repeat | null; series_due: string; remind_offset: number; anchor_day: number; due_time: string | null }>(
    db,
    'SELECT ledger_id, user_id, comment, amount, fund_id, repeat, series_due, remind_offset, anchor_day, due_time FROM reminders WHERE id = ?',
    reminderId,
  );
  if (!r?.repeat) return;
  const due = nextDue(r.series_due, r.repeat, r.anchor_day);
  run(
    db,
    `INSERT INTO reminders (ledger_id, user_id, comment, amount, fund_id, due_date, due_time, remind_at, repeat, series_due, remind_offset, anchor_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.ledger_id, r.user_id, r.comment, r.amount, r.fund_id, due, r.due_time, Date.parse(`${due}T00:00:00Z`) + r.remind_offset, r.repeat, due, r.remind_offset, r.anchor_day,
  );
}

/** Пропуск одного раза серии: этот платёж снимается, следующий ставится. */
export function skipReminder(db: Db, reminderId: number): void {
  run(db, `UPDATE reminders SET inactive_at = datetime('now') WHERE id = ?`, reminderId);
  scheduleNext(db, reminderId);
}

/** Часовой пояс людей: время в сообщениях бота */
const TZ = process.env.APP_TZ ?? 'Asia/Almaty';
export function whenText(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ' в');
}

/** Кнопка под напоминанием: перенос на час или сутки либо удаление. Только свой и ещё не подтверждённый платёж. */
export function reminderAction(db: Db, userId: number, reminderId: number, action: string, now = Date.now()): string {
  const r = get<{ id: number; due_date: string; locked: number; repeat: string | null }>(
    db,
    `SELECT r.id, r.due_date, l.locked, r.repeat FROM reminders r JOIN ledgers l ON l.id = r.ledger_id
     WHERE r.id = ? AND r.user_id = ? AND r.status <> 'done' AND r.inactive_at IS NULL`,
    reminderId,
    userId,
  );
  if (!r) return 'Платёж уже подтверждён или удалён.';
  if (r.locked) return 'База заблокирована, платёж не изменить.';
  if (action === 'x') {
    run(db, `UPDATE reminders SET inactive_at = datetime('now') WHERE id = ?`, r.id);
    return r.repeat ? 'Повторяющийся платёж удалён совсем.' : 'Платёж удалён.';
  }
  if (action === 's') {
    skipReminder(db, r.id);
    return 'В этот раз пропущено, следующий платёж запланирован.';
  }
  const at = now + (action === 'd' ? 86_400_000 : 3_600_000);
  // Дата оплаты не может остаться раньше нового напоминания
  const day = new Date(at).toLocaleDateString('sv-SE', { timeZone: TZ });
  run(db, `UPDATE reminders SET remind_at = ?, status = 'scheduled', due_date = MAX(due_date, ?) WHERE id = ?`, at, day, r.id);
  return `Напомню ${whenText(at)}.`;
}

/** Выплата участнику: уведомление уходит сразу. */
export function noteSettlement(db: Db, ledgerId: number, actorId: number, settlementId: number, recipientId: number): void {
  if (recipientId === actorId || !canNotify(db, recipientId, ledgerId)) return;
  run(db, `INSERT INTO notices (ledger_id, recipient_id, actor_id, kind, ref_id, created_at) VALUES (?, ?, ?, 'settlement', ?, ?)`, ledgerId, recipientId, actorId, settlementId, Date.now());
}

/** Готовые к отправке тексты: выплаты сразу, операции пакетом после тишины. Отобранные записи удаляются. */
export function takeNotices(db: Db, now = Date.now()): Notice[] {
  const out: Notice[] = [];
  const ledgerOf = (id: number) => get<{ name: string; currency: string }>(db, 'SELECT name, currency FROM ledgers WHERE id = ?', id)!;
  const nameOf = (ledgerId: number, userId: number) =>
    get<{ display_name: string }>(db, 'SELECT display_name FROM members WHERE ledger_id = ? AND user_id = ?', ledgerId, userId)?.display_name ?? 'Администратор';

  for (const n of all<{ id: number; ledger_id: number; recipient_id: number; actor_id: number; ref_id: number }>(db, `SELECT id, ledger_id, recipient_id, actor_id, ref_id FROM notices WHERE kind = 'settlement' ORDER BY id`)) {
    run(db, 'DELETE FROM notices WHERE id = ?', n.id);
    const s = get<{ amount: number; comment: string }>(db, 'SELECT amount, comment FROM settlements WHERE id = ? AND inactive_at IS NULL', n.ref_id);
    if (!s || !canNotify(db, n.recipient_id, n.ledger_id)) continue;
    const ledger = ledgerOf(n.ledger_id);
    const owed = memberDebts(db, n.ledger_id).find((d) => d.userId === n.recipient_id)?.owed ?? 0;
    const rest = owed > 0 ? `База ещё должна ${money(owed, ledger.currency)}.` : owed < 0 ? `Переплата ${money(owed, ledger.currency)}.` : 'Долг закрыт.';
    out.push({ chatId: n.recipient_id, ledgerId: n.ledger_id, screen: 'settle', text: `«${ledger.name}»: выплата вам ${money(s.amount, ledger.currency)}${s.comment ? ` (${s.comment})` : ''}, вносит ${nameOf(n.ledger_id, n.actor_id)}. ${rest}` });
  }

  // Напоминания о платежах: свои, поэтому приходят и при выключенных уведомлениях об операциях,
  // но не по базе, где человек выключил уведомления или из которой вышел
  for (const r of all<{ id: number; ledger_id: number; user_id: number; comment: string; amount: number | null; due_date: string; due_time: string | null; repeat: string | null }>(
    db,
    `SELECT id, ledger_id, user_id, comment, amount, due_date, due_time, repeat FROM reminders WHERE status = 'scheduled' AND inactive_at IS NULL AND remind_at <= ? ORDER BY remind_at`,
    now,
  )) {
    run(db, `UPDATE reminders SET status = 'due' WHERE id = ?`, r.id);
    if (r.user_id <= 0 || !ledgerNotify(db, r.user_id, r.ledger_id)) continue;
    const ledger = ledgerOf(r.ledger_id);
    const [, m, d] = r.due_date.split('-');
    out.push({ chatId: r.user_id, ledgerId: r.ledger_id, screen: 'entries', reminderId: r.id, repeating: !!r.repeat, text: `Напоминание «${ledger.name}»: ${r.comment}${r.amount ? `, ${money(r.amount, ledger.currency)}` : ''}, оплатить ${d}.${m}${r.due_time ? ` в ${r.due_time}` : ''}. Подтвердить можно в «Операциях».` });
  }

  // Пакет: все операции одного человека для одного получателя, если он ничего не вносил последние 10 минут
  const groups = all<{ ledger_id: number; recipient_id: number; actor_id: number }>(
    db,
    `SELECT ledger_id, recipient_id, actor_id FROM notices WHERE kind = 'entry' GROUP BY ledger_id, recipient_id, actor_id HAVING MAX(created_at) <= ?`,
    now - BATCH_QUIET_MS,
  );
  for (const g of groups) {
    const ids = all<{ ref_id: number }>(db, `SELECT ref_id FROM notices WHERE kind = 'entry' AND ledger_id = ? AND recipient_id = ? AND actor_id = ?`, g.ledger_id, g.recipient_id, g.actor_id).map((r) => r.ref_id);
    run(db, `DELETE FROM notices WHERE kind = 'entry' AND ledger_id = ? AND recipient_id = ? AND actor_id = ?`, g.ledger_id, g.recipient_id, g.actor_id);
    if (!canNotify(db, g.recipient_id, g.ledger_id)) continue;
    // Снятые за это время операции не считаются
    const rows = all<{ kind: string; amount: number }>(db, `SELECT kind, amount FROM entries WHERE inactive_at IS NULL AND id IN (${ids.map(Number).join(',')})`);
    if (!rows.length) continue;
    const ledger = ledgerOf(g.ledger_id);
    const spent = rows.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.amount, 0);
    const earned = rows.filter((r) => r.kind === 'income').reduce((s, r) => s + r.amount, 0);
    const parts = [spent && `расходы ${spent < 0 ? '−' : ''}${money(spent, ledger.currency)}`, earned && `доходы ${money(earned, ledger.currency)}`].filter(Boolean).join(', ');
    const n = rows.length;
    out.push({ chatId: g.recipient_id, ledgerId: g.ledger_id, screen: 'entries', text: `«${ledger.name}», вносит ${nameOf(g.ledger_id, g.actor_id)}: ${n} ${plural(n, 'новая операция', 'новые операции', 'новых операций')}${parts ? `, ${parts}` : ''}.` });
  }
  return out;
}

/** Раз в полминуты отправляет накопившееся. Ошибка Telegram (человек не запускал бота) не останавливает отправку. */
export function startNotices(db: Db, send: Send): void {
  setInterval(async () => {
    let batch: Notice[] = [];
    try {
      batch = takeNotices(db);
    } catch (e) {
      console.error('Уведомления: не собраны', e);
    }
    for (const m of batch) {
      try {
        await send(m);
      } catch (e) {
        console.error('Уведомление не отправлено', m.chatId, (e as Error).message);
      }
    }
  }, 30_000).unref();
}
