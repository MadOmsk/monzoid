import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { verifyInitData } from '../src/auth.js';
import { handleUpdate, type BotIo, type TgUpdate } from '../src/bot.js';
import { openDb } from '../src/db.js';
import { paceAlerts } from '../src/domain.js';
import { createImportFromRows } from '../src/imports.js';
import { BATCH_QUIET_MS, reminderAction, takeNotices } from '../src/notify.js';
import { backfillPotPrices, refreshMarket, type MarketSource } from '../src/market.js';
import { suggestActions, merchantKey } from '../src/statements/classify.js';
import { parseStatement, type StatementRow } from '../src/statements/parse.js';
import { predictTags, type TagSample } from '../src/tagModel.js';

const k = (tenge: number) => tenge * 100;

function setup() {
  const db = openDb(':memory:');
  const app = buildApp({ db, botToken: 'test', devAuth: true, ownerIds: [1], suggestFunds: async () => new Map() });
  const call = async (user: number, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, headers: { 'x-dev-user': String(user) }, ...(body ? { payload: body as any } : {}) });
    return { status: res.statusCode, body: res.json() };
  };
  return { db, app, call };
}

function shiftYmTest(ym: string, by: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

async function ledger(call: ReturnType<typeof setup>['call']) {
  const { body } = await call(1, 'POST', '/api/ledgers', { name: 'Семья', startYm: '2026-10' });
  const base = `/api/ledgers/${body.id}`;
  const funds = (await call(1, 'GET', `${base}/funds`)).body as { id: number; name: string }[];
  const fund = (name: string) => funds.find((f) => f.name === name)!.id;
  return { base, fund };
}

describe('расчёт месяца', () => {
  it('поиск по операциям: слова в комментарии, фонде и тегах без учёта регистра, число в сумме', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(529_020), fundId: fund('Авто'), comment: 'Ёлочка в Магнуме', tags: ['Озон'] });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(1_500), fundId: fund('Еда'), comment: 'Хлеб' });
    const found = async (q: string) =>
      (await call(1, 'GET', `${base}/entries?from=2026-09&to=2026-10&q=${encodeURIComponent(q)}`)).body.map((e: any) => e.comment);
    expect(await found('магнум')).toEqual(['Ёлочка в Магнуме']);
    expect(await found('елочка #озон')).toEqual(['Ёлочка в Магнуме']);
    expect(await found('еда')).toEqual(['Хлеб']);
    expect(await found('529 020')).toEqual(['Ёлочка в Магнуме']);
    expect(await found('хлеб озон')).toEqual([]);
  });

  it('свободные средства считаются как доход минус план, а остатки идут в фонды', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    await call(1, 'PUT', `${base}/plans/2026-10`, {
      items: [
        { fundId: fund('Еда'), amount: k(500_000) },
        { fundId: fund('Авто'), amount: k(300_000) },
      ],
    });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'income', amount: k(1_200_000) });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(550_000), fundId: fund('Еда') });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-07', kind: 'expense', amount: k(100_000), fundId: fund('Авто') });
    // Возврат уменьшает факт по фонду
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-08', kind: 'expense', amount: k(-10_000), fundId: fund('Авто') });

    const { report } = (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body;
    expect(report.freeDelta).toBe(k(400_000));
    expect(report.funds.find((f: any) => f.name === 'Еда').delta).toBe(k(-50_000));
    expect(report.funds.find((f: any) => f.name === 'Авто').delta).toBe(k(210_000));
    expect(report.fundsDelta).toBe(k(160_000));
    expect(report.totalAfter).toBe(k(560_000));
  });

  it('лимиты и остатки переходят на следующий месяц, закрытый месяц не меняется', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    await call(1, 'PATCH', `${base}/funds/${fund('Еда')}`, { openingBalance: k(1_000) });
    await call(1, 'PUT', `${base}/plans/2026-10`, { items: [{ fundId: fund('Еда'), amount: k(100) }] });
    expect((await call(1, 'POST', `${base}/months/2026-11/close`)).status).toBe(400);
    expect((await call(1, 'POST', `${base}/months/2026-10/close`)).status).toBe(200);

    const blocked = await call(1, 'POST', `${base}/entries`, { date: '2026-10-09', kind: 'expense', amount: k(1), fundId: fund('Еда') });
    expect(blocked.status).toBe(409);

    const { report } = (await call(1, 'GET', `${base}/summary?ym=2026-11`)).body;
    const food = report.funds.find((f: any) => f.name === 'Еда');
    expect(food.planned).toBe(k(100));
    expect(food.balanceBefore).toBe(k(1_100));
    expect(report.freeBefore).toBe(k(-100));
  });

  it('копилка забирает деньги из свободных, а общий итог не меняется', async () => {
    const { call } = setup();
    const { base } = await ledger(call);
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'income', amount: k(1_000) });
    const pot = (await call(1, 'POST', `${base}/pots`, { name: 'Доллары', currency: 'USD' })).body.id;
    await call(1, 'POST', `${base}/pots/${pot}/moves`, { date: '2026-10-06', amount: k(600), units: 1 });
    const { report } = (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body;
    expect(report.freeAfter).toBe(k(400));
    expect(report.potsAfter).toBe(k(600));
    expect(report.totalAfter).toBe(k(1_000));
  });
});

describe('участники', () => {
  async function withMember(ctx: ReturnType<typeof setup>) {
    const l = await ledger(ctx.call);
    const invite = (await ctx.call(1, 'POST', `${l.base}/invites`)).body;
    expect((await ctx.call(2, 'POST', '/api/invites/accept', { token: invite.token })).status).toBe(200);
    return l;
  }

  it('расходы участника копят долг базы, выплата его гасит', async () => {
    const ctx = setup();
    const { base, fund } = await withMember(ctx);
    await ctx.call(2, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(5_000), fundId: fund('Еда') });
    await ctx.call(2, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(-1_000), fundId: fund('Еда') });
    const owed = async () => (await ctx.call(2, 'GET', `${base}/summary?ym=2026-10`)).body.debts[0].owed;
    expect(await owed()).toBe(k(4_000));
    await ctx.call(1, 'POST', `${base}/settlements`, { userId: 2, date: '2026-10-07', amount: k(4_000) });
    expect(await owed()).toBe(0);
    // Выплата не считается новым расходом
    const { report } = (await ctx.call(1, 'GET', `${base}/summary?ym=2026-10`)).body;
    expect(report.spentTotal).toBe(k(4_000));
    // Возврат остаётся среди расходов, доходов тут нет
    const kinds = async (kind: string) => (await ctx.call(1, 'GET', `${base}/entries?ym=2026-10&kind=${kind}`)).body.map((e: any) => e.amount);
    expect(await kinds('expense')).toEqual([k(-1_000), k(5_000)]);
    expect(await kinds('income')).toEqual([]);
    const stats = (await ctx.call(1, 'GET', `${base}/members/stats`)).body;
    expect(stats.months).toEqual([expect.objectContaining({ ym: '2026-10', userId: 2, credit: 0, spent: k(4_000), paid: k(4_000) })]);
    expect(stats.members.map((m: any) => m.userId)).toEqual([1, 2]);
    expect(stats.byFund).toEqual([expect.objectContaining({ userId: 2, fundName: 'Еда', total: k(4_000), count: 2 })]);

    // Личный фонд выбирается явно, по названию сам не находится; его траты считаются, кто бы ни платил
    const personal = (await ctx.call(1, 'POST', `${base}/funds`, { name: `Личные: ${stats.members[0].name}` })).body.id;
    expect((await ctx.call(1, 'GET', `${base}/members/stats`)).body.members[0].fund).toBeNull();
    await ctx.call(1, 'PATCH', `${base}/funds/${personal}`, { ownerUserId: 1 });
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-08', kind: 'expense', amount: k(700), fundId: personal });
    const again = (await ctx.call(1, 'GET', `${base}/members/stats`)).body;
    expect(again.members[0].fund).toEqual({ id: personal, name: `Личные: ${stats.members[0].name}` });
    expect(again.months).toEqual(expect.arrayContaining([expect.objectContaining({ ym: '2026-10', userId: 1, fundSpent: k(700) })]));
  });

  it('личные расходы со скрытием видят только владелец и администраторы', async () => {
    const ctx = setup();
    const { base, fund } = await withMember(ctx);
    const own = (await ctx.call(1, 'POST', `${base}/funds`, { name: 'Личные: админ' })).body.id;
    await ctx.call(1, 'PATCH', `${base}/funds/${own}`, { ownerUserId: 1 });
    const theirs = (await ctx.call(1, 'POST', `${base}/funds`, { name: 'Личные: участник' })).body.id;
    await ctx.call(1, 'PATCH', `${base}/funds/${theirs}`, { ownerUserId: 2 });
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(700), fundId: own, comment: 'подарок', tags: ['секрет'] });
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(300), fundId: theirs, comment: 'своё' });
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(100), fundId: fund('Еда'), comment: 'хлеб' });
    const seen = async (user: number) => (await ctx.call(user, 'GET', `${base}/entries?ym=2026-10`)).body.map((e: any) => e.comment).sort();
    const tagged = async (user: number) => (await ctx.call(user, 'GET', `${base}/tags/stats`)).body.rows.length;

    expect(await seen(2)).toEqual(['подарок', 'своё', 'хлеб']);
    expect((await ctx.call(1, 'PATCH', `${base}/members/1`, { hidePersonal: true })).status).toBe(200);
    expect(await seen(2)).toEqual(['своё', 'хлеб']);
    expect(await tagged(2)).toBe(0);
    expect(await tagged(1)).toBe(1);
    // Участник скрывает свои сам, а администратор всё равно видит; менять другое участник не может
    expect((await ctx.call(2, 'PATCH', `${base}/members/2`, { hidePersonal: true })).status).toBe(200);
    expect((await ctx.call(2, 'PATCH', `${base}/members/2`, { name: 'Другое' })).status).toBe(403);
    expect((await ctx.call(2, 'PATCH', `${base}/members/1`, { hidePersonal: false })).status).toBe(403);
    expect(await seen(1)).toEqual(['подарок', 'своё', 'хлеб']);
    expect(await seen(2)).toEqual(['своё', 'хлеб']);
    // Итоги месяца не меняются
    expect((await ctx.call(2, 'GET', `${base}/summary?ym=2026-10`)).body.report.spentTotal).toBe(k(1_100));
  });

  it('выплата запоминает дату расчёта, её можно отметить и без выплаты', async () => {
    const ctx = setup();
    const { base, fund } = await withMember(ctx);
    await ctx.call(2, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(5_000), fundId: fund('Еда') });
    const debt = async () => (await ctx.call(1, 'GET', `${base}/summary?ym=2026-10`)).body.debts.find((d: any) => d.userId === 2);
    expect((await debt()).settledUntil).toBeNull();
    await ctx.call(1, 'POST', `${base}/settlements`, { userId: 2, date: '2026-10-11', amount: k(5_000), settledUntil: '2026-10-11' });
    expect(await debt()).toEqual(expect.objectContaining({ owed: 0, settledUntil: '2026-10-11' }));
    await ctx.call(1, 'PATCH', `${base}/members/2`, { settledUntil: '2026-10-18' });
    expect((await debt()).settledUntil).toBe('2026-10-18');
    expect((await ctx.call(2, 'PATCH', `${base}/members/2`, { settledUntil: '2026-10-25' })).status).toBe(403);
  });

  it('уведомления: выплата сразу, операции пакетом после тишины, можно отключить', async () => {
    const ctx = setup();
    const { base, fund } = await withMember(ctx);
    const t0 = Date.now();
    // Участник внёс две операции: администратору придёт одно сообщение, но только после 10 минут тишины
    await ctx.call(2, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(1_000), fundId: fund('Еда') });
    await ctx.call(2, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(500), fundId: fund('Еда') });
    expect(takeNotices(ctx.db, t0 + 60_000)).toEqual([]);
    const batch = takeNotices(ctx.db, Date.now() + BATCH_QUIET_MS);
    expect(batch).toEqual([{ chatId: 1, ledgerId: 1, screen: 'entries', text: expect.stringContaining('2 новые операции, расходы 1 500 ₸') }]);
    expect(takeNotices(ctx.db, Date.now() + BATCH_QUIET_MS)).toEqual([]);

    // Администратор внёс за участника: придёт участнику; свой расход никому не приходит
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(300), fundId: fund('Еда'), paidBy: 2 });
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(200), fundId: fund('Еда') });
    expect(takeNotices(ctx.db, Date.now() + BATCH_QUIET_MS)).toEqual([{ chatId: 2, ledgerId: 1, screen: 'entries', text: expect.stringContaining('1 новая операция') }]);

    // Выплата приходит сразу и говорит, сколько осталось
    await ctx.call(1, 'POST', `${base}/settlements`, { userId: 2, date: '2026-10-07', amount: k(1_800) });
    expect(takeNotices(ctx.db)).toEqual([{ chatId: 2, ledgerId: 1, screen: 'settle', text: expect.stringContaining('Долг закрыт') }]);

    // Выключенные уведомления не копятся
    await ctx.call(2, 'PATCH', '/api/me', { notify: false });
    expect((await ctx.call(2, 'GET', '/api/me')).body.user.notify).toBe(false);
    await ctx.call(1, 'POST', `${base}/settlements`, { userId: 2, date: '2026-10-08', amount: k(100) });
    expect(takeNotices(ctx.db, Date.now() + BATCH_QUIET_MS)).toEqual([]);
  });

  it('уведомления по одной базе: выключаются только у себя и только в этой базе, включая напоминания', async () => {
    const ctx = setup();
    const { base, fund } = await withMember(ctx);
    // Чужие уведомления по базе не выключить, даже администратору
    expect((await ctx.call(1, 'PATCH', `${base}/members/2`, { notify: false })).status).toBe(403);
    expect((await ctx.call(2, 'PATCH', `${base}/members/2`, { notify: false })).status).toBe(200);
    expect((await ctx.call(2, 'GET', `${base}/members`)).body.find((m: { userId: number }) => m.userId === 2).notify).toBe(0);
    // Общие уведомления включены, но по этой базе участнику ничего не приходит
    expect((await ctx.call(2, 'GET', '/api/me')).body.user.notify).toBe(true);
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(300), fundId: fund('Еда'), paidBy: 2 });
    await ctx.call(1, 'POST', `${base}/settlements`, { userId: 2, date: '2026-10-07', amount: k(100) });
    expect(takeNotices(ctx.db, Date.now() + BATCH_QUIET_MS)).toEqual([]);
    // Напоминание в этой базе тоже молчит, но срок отмечается
    const soon = Date.now() + 1_000;
    await ctx.call(2, 'POST', `${base}/reminders`, { comment: 'Вода', dueDate: '2026-10-25', remindAt: soon });
    expect(takeNotices(ctx.db, soon)).toEqual([]);
    // Администратору по-прежнему приходит
    await ctx.call(2, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(1_000), fundId: fund('Еда') });
    expect(takeNotices(ctx.db, Date.now() + BATCH_QUIET_MS)).toEqual([{ chatId: 1, ledgerId: 1, screen: 'entries', text: expect.stringContaining('1 новая операция') }]);
    // Включил обратно: снова приходит
    await ctx.call(2, 'PATCH', `${base}/members/2`, { notify: true });
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(200), fundId: fund('Еда'), paidBy: 2 });
    expect(takeNotices(ctx.db, Date.now() + BATCH_QUIET_MS)).toEqual([{ chatId: 2, ledgerId: 1, screen: 'entries', text: expect.stringContaining('1 новая операция') }]);
  });

  it('выход из базы: всегда можно, профиль остаётся без аккаунта, при возвращении человек цепляется к нему', async () => {
    const ctx = setup();
    const { base, fund } = await withMember(ctx);
    // Участник потратил свои: база ему должна; выйти всё равно можно, предупреждение показывает долг
    const paid = (await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(300), fundId: fund('Еда'), paidBy: 2 })).body.id;
    expect((await ctx.call(2, 'GET', `${base}/leave`)).body).toEqual({ owed: k(300), heir: null, blocked: null });
    const soon = Date.now() + 1_000;
    await ctx.call(2, 'POST', `${base}/reminders`, { comment: 'Вода', dueDate: '2026-10-25', remindAt: soon });
    const virtualId = (await ctx.call(2, 'POST', `${base}/leave`)).body.virtualId;
    expect(virtualId).toBeLessThan(0);
    // Базы у человека больше нет, напоминание снято
    expect((await ctx.call(2, 'GET', '/api/me')).body.ledgers).toEqual([]);
    expect((await ctx.call(2, 'GET', `${base}/entries?ym=2026-10`)).status).toBe(403);
    expect(takeNotices(ctx.db, soon)).toEqual([]);
    // У администратора профиль на месте, без аккаунта, с той же операцией и долгом
    const members = (await ctx.call(1, 'GET', `${base}/members`)).body;
    expect(members.find((m: { userId: number }) => m.userId === virtualId)).toMatchObject({ account: null, role: 'member' });
    const entry = (await ctx.call(1, 'GET', `${base}/entries?ym=2026-10`)).body.find((e: { id: number }) => e.id === paid);
    expect(entry.paidBy).toBe(virtualId);
    // Администратор ведёт профиль вручную: выплата гасит долг
    expect((await ctx.call(1, 'POST', `${base}/settlements`, { userId: virtualId, date: '2026-10-07', amount: k(100) })).status).toBe(200);
    // Человек снова входит по обычному приглашению: возвращается в тот же профиль со всей историей
    const invite = (await ctx.call(1, 'POST', `${base}/invites`)).body;
    expect((await ctx.call(2, 'POST', '/api/invites/accept', { token: invite.token })).status).toBe(200);
    const after = (await ctx.call(1, 'GET', `${base}/members`)).body.map((m: { userId: number }) => m.userId).sort();
    expect(after).toEqual([1, 2]);
    expect((await ctx.call(2, 'GET', `${base}/leave`)).body.owed).toBe(k(200));
    expect((await ctx.call(1, 'GET', `${base}/entries?ym=2026-10`)).body.find((e: { id: number }) => e.id === paid).paidBy).toBe(2);
  });

  it('выход единственного администратора: права переходят другому человеку, а последнему выйти нельзя', async () => {
    const ctx = setup();
    const { base } = await withMember(ctx);
    expect((await ctx.call(1, 'GET', `${base}/leave`)).body).toMatchObject({ heir: { userId: 2 }, blocked: null });
    expect((await ctx.call(1, 'POST', `${base}/leave`)).status).toBe(200);
    expect((await ctx.call(2, 'GET', `${base}/members`)).body.find((m: { userId: number }) => m.userId === 2).role).toBe('admin');
    // Остался один человек с аккаунтом: он выйти не может, иначе в базу никто не попадёт
    const last = (await ctx.call(2, 'POST', `${base}/leave`));
    expect(last.status).toBe(400);
    expect(last.body.error).toContain('последний участник');
  });

  it('платёж по расписанию: напоминание в срок, перенос, подтверждение операцией, удаление', async () => {
    const ctx = setup();
    const { base, fund } = await withMember(ctx);
    const soon = Date.now() + 3_600_000;
    const id = (await ctx.call(1, 'POST', `${base}/reminders`, { comment: 'Садик', amount: k(48_000), fundId: fund('Еда'), dueDate: '2026-10-20', remindAt: soon })).body.id;
    // Чужие платежи не видны и не правятся
    expect((await ctx.call(2, 'GET', `${base}/reminders`)).body).toEqual([]);
    expect((await ctx.call(2, 'DELETE', `${base}/reminders/${id}`)).status).toBe(200);
    expect((await ctx.call(1, 'GET', `${base}/reminders`)).body).toHaveLength(1);

    // До срока напоминания нет, в срок приходит одно и платёж ждёт подтверждения
    expect(takeNotices(ctx.db, soon - 1)).toEqual([]);
    expect(takeNotices(ctx.db, soon)).toEqual([{ chatId: 1, ledgerId: 1, screen: 'entries', reminderId: id, repeating: false, text: expect.stringContaining('Садик, 48 000 ₸, оплатить 20.10') }]);
    expect(takeNotices(ctx.db, soon + 1)).toEqual([]);
    expect((await ctx.call(1, 'GET', `${base}/reminders`)).body[0].status).toBe('due');

    // Перенос снова ставит напоминание в очередь
    const later = soon + 86_400_000;
    await ctx.call(1, 'PUT', `${base}/reminders/${id}`, { comment: 'Садик', amount: k(48_000), fundId: fund('Еда'), dueDate: '2026-10-21', remindAt: later });
    expect((await ctx.call(1, 'GET', `${base}/reminders`)).body[0]).toEqual(expect.objectContaining({ status: 'scheduled', dueDate: '2026-10-21' }));

    // До подтверждения в учёте ничего нет; подтверждение создаёт операцию и убирает платёж
    expect((await ctx.call(1, 'GET', `${base}/summary?ym=2026-10`)).body.report.spentTotal).toBe(0);
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-21', kind: 'expense', amount: k(47_000), fundId: fund('Еда'), comment: 'Садик', reminderId: id });
    expect((await ctx.call(1, 'GET', `${base}/summary?ym=2026-10`)).body.report.spentTotal).toBe(k(47_000));
    expect((await ctx.call(1, 'GET', `${base}/reminders`)).body).toEqual([]);
    expect((await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-21', kind: 'expense', amount: k(1), fundId: fund('Еда'), reminderId: id })).status).toBe(409);
    expect(takeNotices(ctx.db, later + 1)).toEqual([]);

    // Кнопки под напоминанием: перенос на час и удаление, чужой платёж не трогают
    const tap = async (user: number, data: string) => {
      const edited: string[] = [];
      const io: BotIo = { send: async () => {}, edit: async (_c, _m, text) => void edited.push(text), answer: async () => {}, download: async () => new Uint8Array() };
      await handleUpdate(ctx.db, io, { update_id: 1, callback_query: { id: 'c', from: { id: user }, data, message: { message_id: 5, chat: { id: user, type: 'private' }, text: 'Напоминание' } } });
      return edited[0];
    };
    const snoozed = (await ctx.call(1, 'POST', `${base}/reminders`, { comment: 'Вода', dueDate: '2026-10-25', remindAt: soon })).body.id;
    expect(await tap(2, `r:x:${snoozed}`)).toContain('уже подтверждён или удалён');
    expect(await tap(1, `r:h:${snoozed}`)).toContain('Напомню');
    expect((await ctx.call(1, 'GET', `${base}/reminders`)).body[0].remindAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await tap(1, `r:x:${snoozed}`)).toContain('Платёж удалён');
    expect((await ctx.call(1, 'GET', `${base}/reminders`)).body).toEqual([]);

    // Удалённый платёж не напоминает
    const other = (await ctx.call(1, 'POST', `${base}/reminders`, { comment: 'Интернет', dueDate: '2026-10-25', remindAt: soon })).body.id;
    await ctx.call(1, 'DELETE', `${base}/reminders/${other}`);
    expect((await ctx.call(1, 'GET', `${base}/reminders`)).body).toEqual([]);
    expect(takeNotices(ctx.db, later)).toEqual([]);
  });

  it('повторяющийся платёж: следующий раз после подтверждения и пропуска, по плановой дате и с тем же временем', async () => {
    const ctx = setup();
    const { base, fund } = await withMember(ctx);
    const list = async () => (await ctx.call(1, 'GET', `${base}/reminders`)).body;
    // 31-е: в ноябре 30-е, в декабре снова 31-е; напоминание за сутки в 10:00 UTC
    const remindAt = Date.parse('2026-10-30T10:00:00Z');
    const id = (await ctx.call(1, 'POST', `${base}/reminders`, { comment: 'Садик', amount: k(48_000), fundId: fund('Еда'), dueDate: '2026-10-31', remindAt, repeat: 'month' })).body.id;
    // Перенос этого раза кнопкой бота не сдвигает следующий
    reminderAction(ctx.db, 1, id, 'd', remindAt);
    await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-31', kind: 'expense', amount: k(48_000), fundId: fund('Еда'), reminderId: id });
    const [nov] = await list();
    expect(nov).toEqual(expect.objectContaining({ dueDate: '2026-11-30', remindAt: Date.parse('2026-11-29T10:00:00Z'), repeat: 'month', status: 'scheduled', amount: k(48_000) }));
    // Пропуск ставит следующий раз, удаление снимает серию
    expect((await ctx.call(1, 'POST', `${base}/reminders/${nov.id}/skip`, {})).status).toBe(200);
    const [dec] = await list();
    expect(dec.dueDate).toBe('2026-12-31');
    expect(reminderAction(ctx.db, 1, dec.id, 's')).toContain('пропущено');
    const [jan] = await list();
    expect(jan.dueDate).toBe('2027-01-31');
    await ctx.call(1, 'DELETE', `${base}/reminders/${jan.id}`);
    expect(await list()).toEqual([]);

    // Еженедельный и разовый
    const week = (await ctx.call(1, 'POST', `${base}/reminders`, { comment: 'Уборка', dueDate: '2026-10-05', remindAt: Date.parse('2026-10-05T04:00:00Z'), repeat: 'week' })).body.id;
    await ctx.call(1, 'POST', `${base}/reminders/${week}/skip`, {});
    expect((await list())[0].dueDate).toBe('2026-10-12');
    const once = (await ctx.call(1, 'POST', `${base}/reminders`, { comment: 'Разово', dueDate: '2026-10-07', remindAt })).body.id;
    await ctx.call(1, 'POST', `${base}/reminders/${once}/skip`, {});
    expect((await list()).map((r: any) => r.comment)).toEqual(['Уборка']);
  });

  it('оформление: дневная и ночная схемы и режим, чужие названия не принимаются', async () => {
    const ctx = setup();
    await withMember(ctx);
    const look = async () => (await ctx.call(2, 'GET', '/api/me')).body.user;
    expect(await look()).toEqual(expect.objectContaining({ theme: 'sky', themeNight: 'midnight', themeMode: 'telegram' }));
    await ctx.call(2, 'PATCH', '/api/me', { theme: 'sky', themeNight: 'aurora', themeMode: 'night', design: 'soft' });
    expect(await look()).toEqual(expect.objectContaining({ theme: 'sky', themeNight: 'aurora', themeMode: 'night', design: 'soft' }));
    expect((await ctx.call(2, 'PATCH', '/api/me', { themeMode: 'evening' })).status).toBe(400);
    await ctx.call(2, 'PATCH', '/api/me', { themeMode: 'telegram' });
    expect((await look()).themeMode).toBe('telegram');
    expect((await ctx.call(2, 'PATCH', '/api/me', { themeNight: 'neon' })).status).toBe(400);
  });

  it('участник не может менять чужое и настройки, посторонний не видит базу', async () => {
    const ctx = setup();
    const { base, fund } = await withMember(ctx);
    const adminEntry = (await ctx.call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(100), fundId: fund('Еда') })).body.id;
    expect((await ctx.call(2, 'DELETE', `${base}/entries/${adminEntry}`)).status).toBe(403);
    expect((await ctx.call(2, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'income', amount: k(100) })).status).toBe(403);
    expect((await ctx.call(2, 'PUT', `${base}/plans/2026-10`, { items: [] })).status).toBe(403);
    expect((await ctx.call(2, 'POST', `${base}/months/2026-10/close`)).status).toBe(403);
    expect((await ctx.call(3, 'GET', `${base}/summary?ym=2026-10`)).status).toBe(403);
  });
});

describe('основная валюта и копилки', () => {
  const market = (over: Partial<MarketSource> = {}): MarketSource => ({
    rates: async () => ({ date: '2026-11-02', perUsd: { USD: 1, KZT: 500, EUR: 0.9 } }),
    quote: async (ticker) => (ticker === 'AAPL' ? { price: 200, currency: 'USD' } : null),
    ratesOn: async () => ({}),
    history: async () => null,
    daily: async () => null,
    ...over,
  });

  function start(source = market()) {
    const db = openDb(':memory:');
    const app = buildApp({ db, botToken: 'test', devAuth: true, ownerIds: [1], suggestFunds: async () => new Map(), market: source });
    const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => {
      const res = await app.inject({ method, url, headers: { 'x-dev-user': '1' }, ...(body ? { payload: body as any } : {}) });
      return { status: res.statusCode, body: res.json() };
    };
    return { db, call };
  }

  it('оценивает валюту и акции по курсу, а учёт считает по вложенному', async () => {
    const { db, call } = start();
    await refreshMarket(db, market(), '2026-11-02');
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-10' })).body.id}`;
    const usd = (await call('POST', `${base}/pots`, { name: 'Доллары', kind: 'currency', currency: 'USD' })).body.id;
    await call('POST', `${base}/pots/${usd}/moves`, { date: '2026-10-06', amount: k(45000), units: 100 });
    expect((await call('POST', `${base}/pots`, { name: 'Нет такой', kind: 'stock', ticker: 'NOPE' })).status).toBe(400);
    // Уже имеющиеся акции не списываются со свободных средств
    await call('POST', `${base}/pots`, { name: 'Apple', kind: 'stock', ticker: 'aapl', openingBalance: k(80000), openingUnits: 1 });

    const pots = (await call('GET', `${base}/pots`)).body;
    expect(pots[0]).toMatchObject({ balance: k(45000), units: 100, value: k(50000), price: 500 });
    expect(pots[1]).toMatchObject({ ticker: 'AAPL', currency: 'USD', price: 200, value: k(100000), balance: k(80000) });
    const { report } = (await call('GET', `${base}/summary?ym=2026-10`)).body;
    expect(report).toMatchObject({ potsAfter: k(150000), potsInvested: k(125000), freeAfter: -k(45000), totalAfter: k(105000) });

  });

  it('фиксирует стоимость на конец месяца: рост курса виден как рост, прошлое не меняется', async () => {
    const { db, call } = start();
    const at = (kzt: number) => market({ rates: async () => ({ date: '2026-10-01', perUsd: { USD: 1, KZT: kzt } }) });
    await refreshMarket(db, at(450), '2026-09-20');
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-09' })).body.id}`;
    const usd = (await call('POST', `${base}/pots`, { name: 'Доллары', kind: 'currency', currency: 'USD' })).body.id;
    await call('POST', `${base}/pots/${usd}/moves`, { date: '2026-09-20', amount: k(45000), units: 100 });
    const report = async (ym: string) => (await call('GET', `${base}/summary?ym=${ym}`)).body.report;

    await refreshMarket(db, at(460), '2026-09-30');
    await refreshMarket(db, at(550), '2026-10-31');
    expect(await report('2026-09')).toMatchObject({ potsAfter: k(46000), freeAfter: -k(45000) });
    expect(await report('2026-10')).toMatchObject({ potsAfter: k(55000), potsInvested: k(45000), freeAfter: -k(45000), totalAfter: k(10000) });

    await refreshMarket(db, at(600), '2026-11-02');
    expect((await report('2026-09')).potsAfter).toBe(k(46000));
    expect((await report('2026-10')).potsAfter).toBe(k(55000));
  });

  it('вклад считает количество на конец каждого месяца', async () => {
    const { db, call } = start();
    await refreshMarket(db, market(), '2026-11-02');
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-09' })).body.id}`;
    const usd = (await call('POST', `${base}/pots`, { name: 'Доллары', kind: 'currency', currency: 'USD' })).body.id;
    await call('POST', `${base}/pots/${usd}/moves`, { date: '2026-09-06', amount: k(45000), units: 100 });
    await call('POST', `${base}/pots/${usd}/moves`, { date: '2026-10-06', amount: -k(22500), units: -50 });
    expect((await call('GET', `${base}/summary?ym=2026-09`)).body.report.potsAfter).toBe(k(50000));
    expect((await call('GET', `${base}/summary?ym=2026-10`)).body.report).toMatchObject({ potsAfter: k(25000), potsInvested: k(22500) });
  });

  it('проданная до нуля валюта стоит 0, разница покупки и продажи остаётся доходом или убытком', async () => {
    const { db, call } = start();
    await refreshMarket(db, market(), '2026-11-02');
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-09' })).body.id}`;
    const usd = (await call('POST', `${base}/pots`, { name: 'Доллары', kind: 'currency', currency: 'USD' })).body.id;
    await call('POST', `${base}/pots/${usd}/moves`, { date: '2026-09-06', amount: k(45000), units: 100 });
    await call('POST', `${base}/pots/${usd}/moves`, { date: '2026-10-06', amount: -k(40000), units: -100 });
    expect((await call('GET', `${base}/summary?ym=2026-10`)).body.report).toMatchObject({ potsAfter: 0, freeAfter: -k(5000), totalAfter: -k(5000) });
    expect((await call('GET', `${base}/pots`)).body[0]).toMatchObject({ units: 0, value: 0, balance: k(5000) });
  });

  it('актив: покупка и продажа не попадают в доходы и расходы, стоимость по последней оценке', async () => {
    const { db, call } = start();
    await refreshMarket(db, market(), '2026-11-02');
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-08' })).body.id}`;
    // Старая квартира была до начала базы: стоимость на старт входит в итог, свободные не трогает
    const old = (await call('POST', `${base}/pots`, { name: 'Старая квартира', kind: 'asset', openingBalance: k(30000) })).body.id;
    const flat = (await call('POST', `${base}/pots`, { name: 'Квартира', kind: 'asset' })).body.id;
    await call('POST', `${base}/pots/${old}/moves`, { date: '2026-09-03', amount: -k(33000) });
    await call('POST', `${base}/pots/${flat}/moves`, { date: '2026-09-18', amount: k(28000) });
    // Ремонт добавляется к уплаченному, но не делает квартиру второй
    await call('POST', `${base}/pots/${flat}/moves`, { date: '2026-10-02', amount: k(1000) });
    expect((await call('POST', `${base}/pots/${old}/moves`, { date: '2026-10-05', amount: -k(1) })).status).toBe(400);

    const report = async (ym: string) => (await call('GET', `${base}/summary?ym=${ym}`)).body.report;
    expect(await report('2026-08')).toMatchObject({ income: 0, assetsAfter: k(30000), moneyAfter: 0, totalAfter: k(30000), potsAfter: 0 });
    expect(await report('2026-09')).toMatchObject({ income: 0, spentTotal: 0, assetMoves: -k(5000), freeAfter: k(5000), assetsAfter: k(28000), assetsInvested: k(25000), totalAfter: k(33000) });

    // Оценка в закрытом месяце требует согласия и попадает в журнал, новая оценка не стирает старую
    await call('POST', `${base}/months/2026-08/close`);
    await call('POST', `${base}/months/2026-09/close`);
    expect((await call('POST', `${base}/pots/${flat}/values`, { date: '2026-09-30', value: k(31000) })).status).toBe(409);
    expect((await call('POST', `${base}/pots/${flat}/values`, { date: '2026-09-30', value: k(31000), recalc: true })).status).toBe(200);
    const later = (await call('POST', `${base}/pots/${flat}/values`, { date: '2026-10-20', value: k(32000), comment: 'по объявлениям' })).body.id;
    expect((await report('2026-09')).assetsAfter).toBe(k(31000));
    expect(await report('2026-10')).toMatchObject({ assetsAfter: k(32000), assetsInvested: k(26000), freeAfter: k(4000), totalAfter: k(36000) });
    expect((await call('GET', `${base}/pots/${flat}/values`)).body.map((v: any) => v.value)).toEqual([k(32000), k(31000)]);
    const pots = (await call('GET', `${base}/pots`)).body;
    expect(pots.find((p: any) => p.id === flat)).toMatchObject({ kind: 'asset', units: 1, value: k(32000), balance: k(29000), valuedAt: '2026-10-20' });
    expect(pots.find((p: any) => p.id === old)).toMatchObject({ units: 0, value: 0 });

    expect((await call('DELETE', `${base}/pots/${flat}/values/${later}`)).status).toBe(200);
    expect((await report('2026-10')).assetsAfter).toBe(k(31000));
    const changes = (await call('GET', `${base}/changes`)).body;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'asset_value', action: 'create', fundAfter: 'Квартира' });
    expect((await call('POST', `${base}/changes/${changes[0].id}/revert`)).status).toBe(200);
    expect((await report('2026-09')).assetsAfter).toBe(k(28000));
    // Активы не получают курсов и цен вкладов
    await refreshMarket(db, market(), '2026-11-03');
    expect(db.prepare('SELECT COUNT(*) n FROM pot_prices').get()).toEqual({ n: 0 });
  });

  it('сделки вклада правятся и снимаются, в закрытом месяце через журнал; вклад переименовывается', async () => {
    const { db, call } = start();
    await refreshMarket(db, market(), '2026-11-02');
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-09' })).body.id}`;
    const flat = (await call('POST', `${base}/pots`, { name: 'Квартира', kind: 'asset' })).body.id;
    const buy = (await call('POST', `${base}/pots/${flat}/moves`, { date: '2026-09-18', amount: k(28000) })).body.id;
    const sell = (await call('POST', `${base}/pots/${flat}/moves`, { date: '2026-10-20', amount: -k(30000) })).body.id;
    const report = async (ym: string) => (await call('GET', `${base}/summary?ym=${ym}`)).body.report;

    // Продажу нельзя сдвинуть раньше покупки, покупку нельзя превратить в продажу
    expect((await call('PUT', `${base}/pots/${flat}/moves/${sell}`, { date: '2026-09-10', amount: -k(30000) })).status).toBe(400);
    expect((await call('PUT', `${base}/pots/${flat}/moves/${buy}`, { date: '2026-09-18', amount: -k(28000) })).status).toBe(400);

    await call('POST', `${base}/months/2026-09/close`);
    expect((await call('PUT', `${base}/pots/${flat}/moves/${buy}`, { date: '2026-09-15', amount: k(27000), comment: 'по договору' })).status).toBe(409);
    expect((await call('PUT', `${base}/pots/${flat}/moves/${buy}`, { date: '2026-09-15', amount: k(27000), comment: 'по договору', recalc: true })).status).toBe(200);
    expect(await report('2026-09')).toMatchObject({ assetMoves: k(27000), assetsAfter: k(27000) });
    // Покупку не снять, пока есть продажа
    expect((await call('DELETE', `${base}/pots/${flat}/moves/${buy}?recalc=1`)).status).toBe(400);
    expect((await call('DELETE', `${base}/pots/${flat}/moves/${sell}`)).status).toBe(200);
    expect((await report('2026-10')).assetsAfter).toBe(k(27000));

    const changes = (await call('GET', `${base}/changes`)).body;
    expect(changes).toMatchObject([{ kind: 'pot_move', action: 'update', fundAfter: 'Квартира' }]);
    expect((await call('POST', `${base}/changes/${changes[0].id}/revert`)).status).toBe(200);
    expect((await report('2026-09')).assetMoves).toBe(k(28000));

    expect((await call('PATCH', `${base}/pots/${flat}`, { name: 'Квартира на Абая' })).status).toBe(200);
    expect((await call('GET', `${base}/pots`)).body[0]).toMatchObject({ name: 'Квартира на Абая', units: 1 });
  });

  it('заполняет прошлые месяцы настоящими ценами и не трогает зафиксированные', async () => {
    const source = market({
      ratesOn: async (date): Promise<Record<string, number>> => (date.startsWith('2026-09') ? { USD: 450 } : date.startsWith('2026-10') ? { USD: 500 } : {}),
      history: async () => ({ currency: 'USD', closes: { '2026-09': 100, '2026-10': 110 } }),
    });
    const { db, call } = start(source);
    await refreshMarket(db, source, '2026-11-01');
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-09' })).body.id}`;
    const usd = (await call('POST', `${base}/pots`, { name: 'Доллары', kind: 'currency', currency: 'USD', openingBalance: k(450), openingUnits: 1 })).body.id;
    await call('POST', `${base}/pots`, { name: 'Apple', kind: 'stock', ticker: 'AAPL', openingBalance: k(45000), openingUnits: 1 });
    await backfillPotPrices(db, source, '2026-11-01');
    const report = async (ym: string) => (await call('GET', `${base}/summary?ym=${ym}`)).body.report;
    expect((await report('2026-09')).potsAfter).toBe(k(450 + 45000));
    expect((await report('2026-10')).potsAfter).toBe(k(500 + 55000));

    db.prepare('UPDATE pot_prices SET unit_value = 1 WHERE pot_id = ? AND ym = ?').run(usd, '2026-09');
    await backfillPotPrices(db, source, '2026-11-01');
    expect((await report('2026-09')).potsAfter).toBe(1 + k(45000));
  });

  it('отдаёт котировки за два года и цену покупок в валюте котировки', async () => {
    let dailyCalls = 0;
    const source = market({
      ratesOn: async (): Promise<Record<string, number>> => ({ USD: 450 }),
      daily: async () => {
        dailyCalls += 1;
        return { currency: 'USD', closes: [{ date: '2026-10-01', price: 190 }, { date: '2026-10-02', price: 200 }] };
      },
    });
    const { db, call } = start(source);
    await refreshMarket(db, source, '2026-11-02');
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-10' })).body.id}`;
    const apple = (await call('POST', `${base}/pots`, { name: 'Apple', kind: 'stock', ticker: 'AAPL' })).body.id;
    await call('POST', `${base}/pots/${apple}/moves`, { date: '2026-10-06', amount: k(90000), units: 2 });
    const usd = (await call('POST', `${base}/pots`, { name: 'Доллары', kind: 'currency', currency: 'USD' })).body.id;
    await call('POST', `${base}/pots/${usd}/moves`, { date: '2026-10-06', amount: k(44000), units: 100 });

    const stock = (await call('GET', `${base}/pots/${apple}/quotes`)).body;
    expect(stock).toEqual({ currency: 'USD', points: [{ date: '2026-10-01', price: 190 }, { date: '2026-10-02', price: 200 }], moves: [{ id: expect.any(Number), date: '2026-10-06', amount: k(90000), units: 2, comment: '', price: 100 }] });
    await call('GET', `${base}/pots/${apple}/quotes`);
    expect(dailyCalls).toBe(1);

    const cash = (await call('GET', `${base}/pots/${usd}/quotes`)).body;
    expect(cash.currency).toBe('KZT');
    expect(cash.points).toHaveLength(105);
    expect(cash.points[0].price).toBe(450);
    expect(cash.moves[0].price).toBe(440);
  });

  it('покупка акций по тикеру и цене: вклад заводится сам, сумма по курсу на дату, продать больше, чем есть, нельзя', async () => {
    const source = market({ ratesOn: async (date): Promise<Record<string, number>> => (date === '2026-10-03' ? { USD: 480 } : {}) });
    const { db, call } = start(source);
    await refreshMarket(db, source, '2026-11-02');
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-10' })).body.id}`;
    expect((await call('POST', `${base}/stocks/trade`, { ticker: 'nope', side: 'buy', units: 1, price: 10, date: '2026-10-03' })).status).toBe(400);
    expect((await call('POST', `${base}/stocks/trade`, { ticker: 'AAPL', side: 'sell', units: 1, price: 10, date: '2026-10-03' })).status).toBe(400);
    // Курс на дату есть: 480; вклад AAPL появился сам
    const buy = await call('POST', `${base}/stocks/trade`, { ticker: 'aapl', side: 'buy', units: 2, price: 190.5, date: '2026-10-03' });
    expect(buy.status).toBe(200);
    expect(buy.body).toMatchObject({ amount: k(2 * 190.5 * 480), rate: 480 });
    // Курса на дату нет: берётся последний (500), вклад тот же
    const more = await call('POST', `${base}/stocks/trade`, { ticker: 'AAPL', side: 'buy', units: 1, price: 200, date: '2026-10-04' });
    expect(more.body).toMatchObject({ potId: buy.body.potId, amount: k(200 * 500), rate: 500 });
    expect((await call('POST', `${base}/stocks/trade`, { ticker: 'AAPL', side: 'sell', units: 4, price: 210, date: '2026-10-05' })).status).toBe(400);
    const sell = await call('POST', `${base}/stocks/trade`, { ticker: 'AAPL', side: 'sell', units: 1, price: 210, date: '2026-10-05' });
    expect(sell.body.amount).toBe(-k(210 * 500));
    const pot = (await call('GET', `${base}/pots`)).body.find((p: { id: number }) => p.id === buy.body.potId);
    expect(pot).toMatchObject({ name: 'AAPL', kind: 'stock', ticker: 'AAPL', currency: 'USD', units: 2, balance: k(2 * 190.5 * 480 + 200 * 500 - 210 * 500) });
    const moves = (await call('GET', `${base}/pots/${buy.body.potId}/quotes`)).body.moves;
    expect(moves[0].comment).toBe('2 × 190.5 USD, курс 480');
    expect(moves[1].comment).toBe('1 × 200 USD, курс 500 (последний)');

    // Цена в тенге вместо долларов без пометки: сервер просит проверить валюту
    const wrong = await call('POST', `${base}/stocks/trade`, { ticker: 'AAPL', side: 'buy', units: 1, price: 95000, date: '2026-10-04' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toContain('Проверь валюту цены');
    // Та же цена с пометкой «в тенге» записывается как есть
    const inBase = await call('POST', `${base}/stocks/trade`, { ticker: 'AAPL', side: 'buy', units: 1, price: 95000, priceIn: 'base', date: '2026-10-04' });
    expect(inBase.body.amount).toBe(k(95000));
    // Подтверждённая необычная цена тоже записывается
    expect((await call('POST', `${base}/stocks/trade`, { ticker: 'AAPL', side: 'buy', units: 1, price: 1000, priceChecked: true, date: '2026-10-04' })).status).toBe(200);

    // Правка сделки по цене за штуку: в тенге как есть, в долларах по курсу на дату
    const potId = buy.body.potId;
    const fix = (body: object) => call('PUT', `${base}/pots/${potId}/moves/${buy.body.id}`, { date: '2026-10-03', amount: 1, units: 2, comment: '', ...body });
    expect((await fix({ price: 90000, priceIn: 'base' })).status).toBe(200);
    let edited = (await call('GET', `${base}/pots/${potId}/quotes`)).body.moves.find((m: { id: number }) => m.id === buy.body.id);
    expect(edited.amount).toBe(k(180000));
    expect((await fix({ price: 191 })).status).toBe(200);
    edited = (await call('GET', `${base}/pots/${potId}/quotes`)).body.moves.find((m: { id: number }) => m.id === buy.body.id);
    expect(edited.amount).toBe(k(2 * 191 * 480));
  });

  it('берёт курс на дату операции, а без него последний', async () => {
    const source = market({ ratesOn: async (date): Promise<Record<string, number>> => (date === '2026-10-03' ? { USD: 480 } : {}) });
    const { db, call } = start(source);
    await refreshMarket(db, source, '2026-11-02');
    const ledger = (await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-10' })).body.id;
    const base = `/api/ledgers/${ledger}`;
    const row = (hash: string, date: string): StatementRow => ({ hash, bank: 'freedom', account: '1', date, amount: -1000, currency: 'USD', op: 'Покупка', details: 'SHOP', pending: false });
    const batch = await createImportFromRows(db, async () => new Map(), ledger, 1, ['a.pdf'], [row('a', '2026-10-03'), row('b', '2026-10-04')], [], source);
    const { rows } = (await call('GET', `${base}/imports/${batch}`)).body;
    expect(rows.find((r: any) => r.date === '2026-10-03')).toMatchObject({ baseAmount: -480000, rate: 480, rateDate: '2026-10-03' });
    expect(rows.find((r: any) => r.date === '2026-10-04')).toMatchObject({ baseAmount: -500000, rate: 500 });
  });

  it('операция в другой валюте проводится по курсу, а сумму можно поправить', async () => {
    const { db, call } = start();
    await refreshMarket(db, market(), '2026-11-02');
    const ledger = (await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-10' })).body.id;
    const base = `/api/ledgers/${ledger}`;
    const funds = (await call('GET', `${base}/funds`)).body;
    const fundId = funds[0].id;
    const row = (hash: string, currency: string, amount: number): StatementRow => ({ hash, bank: 'freedom', account: '1', date: '2026-10-03', amount, currency, op: 'Покупка', details: 'ALIEXPRESS', pending: false });
    const batch = await createImportFromRows(db, async () => new Map(), ledger, 1, ['a.pdf'], [row('a', 'USD', -1066), row('b', 'KZT', -253498)], []);
    const { rows } = (await call('GET', `${base}/imports/${batch}`)).body;
    const usd = rows.find((r: any) => r.currency === 'USD');
    expect(usd).toMatchObject({ suggestedAction: 'expense', baseAmount: -533000, rate: 500 });
    expect(usd.hint).toContain('часть операции');
    const other = rows.find((r: any) => r.currency === 'KZT');
    const res = await call('POST', `${base}/imports/${batch}/decide`, {
      decisions: [
        { rowId: usd.id, action: 'expense', parts: [{ fundId, amount: 540000 }] },
        { rowId: other.id, action: 'expense', parts: [{ fundId, amount: 253498 }] },
      ],
    });
    expect(res.status).toBe(200);
    const list = (await call('GET', `${base}/entries?ym=2026-10`)).body;
    expect(list.reduce((s: number, e: any) => s + e.amount, 0)).toBe(793498);
    expect(list.find((e: any) => e.amount === 540000).description).toBe('ALIEXPRESS (10.66 USD)');
  });

  it('сбой источника оставляет прошлые курсы', async () => {
    const { db, call } = start();
    expect(await refreshMarket(db, market(), '2026-11-02')).toBe(true);
    const base = `/api/ledgers/${(await call('POST', '/api/ledgers', { name: 'Семья', startYm: '2026-10' })).body.id}`;
    await call('POST', `${base}/pots`, { name: 'Евро', kind: 'currency', currency: 'EUR', openingBalance: k(100), openingUnits: 9 });
    const broken = market({ rates: async () => { throw new Error('нет сети'); } });
    expect(await refreshMarket(db, broken, '2026-11-03')).toBe(false);
    expect((await call('GET', `${base}/pots`)).body[0]).toMatchObject({ value: k(5000), rateDate: '2026-11-02' });
  });

  it('база в долларах хранит валюту, не даёт её сменить и оценивает тенге', async () => {
    const { db, call } = start();
    await refreshMarket(db, market(), '2026-11-02');
    const ledger = (await call('POST', '/api/ledgers', { name: 'USD', startYm: '2026-10', currency: 'USD' })).body.id;
    const base = `/api/ledgers/${ledger}`;
    expect((await call('GET', '/api/me')).body.ledgers[0].currency).toBe('USD');
    await call('POST', `${base}/pots`, { name: 'Тенге', kind: 'currency', currency: 'KZT', openingBalance: k(100), openingUnits: 50000 });
    expect((await call('GET', `${base}/pots`)).body[0].value).toBe(k(100));

    const row: StatementRow = { hash: 'a', bank: 'kaspi', account: '1', date: '2026-10-10', amount: -100, currency: 'KZT', op: 'Покупка', details: 'SHOP', pending: false };
    const batch = await createImportFromRows(db, async () => new Map(), ledger, 1, ['a.pdf'], [row], []);
    const imported = (await call('GET', `${base}/imports/${batch}`)).body;
    expect(imported.baseCurrency).toBe('USD');
    expect(imported.rows[0]).toMatchObject({ suggestedAction: 'expense', baseAmount: 0 });
  });
});

describe('начисление участнику', () => {
  const now = new Date().toISOString().slice(0, 7);

  async function start() {
    const ctx = setup();
    const { body } = await ctx.call(1, 'POST', '/api/ledgers', { name: 'Семья', startYm: now });
    const base = `/api/ledgers/${body.id}`;
    const funds = (await ctx.call(1, 'GET', `${base}/funds`)).body as { id: number; name: string }[];
    const fund = funds.find((f) => f.name === 'Прочее')!.id;
    const person = (await ctx.call(1, 'POST', `${base}/members/virtual`, { name: 'Анна' })).body.userId;
    const plan = (amount: number) => ctx.call(1, 'PUT', `${base}/plans/${now}`, { items: [{ fundId: fund, amount }] });
    const state = async () => {
      const summary = (await ctx.call(1, 'GET', `${base}/summary?ym=${now}`)).body;
      return { owed: summary.debts.find((d: any) => d.userId === person).owed, row: summary.report.funds.find((f: any) => f.id === fund) };
    };
    return { ...ctx, base, fund, person, plan, state };
  }

  it('сумма плана идёт в долг, остаток фонда нулевой, запись следует за планом и не дублируется', async () => {
    const { call, base, fund, person, plan, state } = await start();
    await plan(k(50000));
    expect((await call(1, 'PATCH', `${base}/funds/${fund}`, { creditUserId: 99 })).status).toBe(404);
    await call(1, 'PATCH', `${base}/funds/${fund}`, { creditUserId: person });
    expect(await state()).toMatchObject({ owed: k(50000), row: { planned: k(50000), spent: k(50000), balanceAfter: 0 } });
    await state();
    const list = (await call(1, 'GET', `${base}/entries?ym=${now}`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ autoCredit: 1, paidBy: person });

    await plan(k(70000));
    expect((await state()).owed).toBe(k(70000));
    expect((await call(1, 'GET', `${base}/entries?ym=${now}`)).body).toHaveLength(1);

    expect((await call(1, 'DELETE', `${base}/entries/${list[0].id}`)).status).toBe(400);
    expect((await call(1, 'PUT', `${base}/entries/${list[0].id}`, { date: `${now}-02`, kind: 'expense', amount: k(1), fundId: fund })).status).toBe(400);

    await plan(0);
    expect((await state()).owed).toBe(0);
    await plan(k(30000));
    expect((await state()).owed).toBe(k(30000));

    await call(1, 'PATCH', `${base}/funds/${fund}`, { creditUserId: null });
    expect(await state()).toMatchObject({ owed: 0, row: { spent: 0, balanceAfter: k(30000) } });
  });

  it('новый месяц начисляется сам, закрытый не меняется', async () => {
    const { db, call, base, fund, person, plan, state } = await start();
    await plan(k(100));
    const ledgerId = Number(base.split('/').pop());
    // Включено раньше: месяц начала базы и настройки сдвигаются назад
    const prev = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    db.prepare('UPDATE ledgers SET start_ym = ? WHERE id = ?').run(prev, ledgerId);
    db.prepare('INSERT INTO plans (ledger_id, ym, fund_id, amount) VALUES (?, ?, ?, ?)').run(ledgerId, prev, fund, k(100));
    db.prepare('UPDATE funds SET credit_user_id = ?, credit_from = ? WHERE id = ?').run(person, prev, fund);
    expect((await state()).owed).toBe(k(200));

    await call(1, 'POST', `${base}/months/${prev}/close`);
    db.prepare('UPDATE plans SET amount = ? WHERE ledger_id = ? AND ym = ?').run(k(999), ledgerId, prev);
    expect((await state()).owed).toBe(k(200));
    await call(1, 'PATCH', `${base}/funds/${fund}`, { creditUserId: null });
    expect((await state()).owed).toBe(k(100));
  });

  it('темп не проверяется, а после связи начисление идёт настоящему человеку', async () => {
    const { db, call, base, fund, person, plan, state } = await start();
    await plan(k(100));
    await call(1, 'PATCH', `${base}/funds/${fund}`, { creditUserId: person });
    const ledgerId = Number(base.split('/').pop());
    expect(paceAlerts(db, ledgerId, now, `${now}-27`)).toEqual([]);

    const token = (await call(1, 'POST', `${base}/members/${person}/link-invite`)).body.token;
    await call(2, 'POST', '/api/invites/accept', { token });
    await state().catch(() => null);
    const debts = (await call(1, 'GET', `${base}/summary?ym=${now}`)).body.debts;
    expect(debts.find((d: any) => d.userId === 2).owed).toBe(k(100));
    expect((await call(1, 'GET', `${base}/funds`)).body.find((f: any) => f.id === fund).creditUserId).toBe(2);
    expect((await call(1, 'GET', `${base}/entries?ym=${now}`)).body).toHaveLength(1);
  });
});

describe('статистика', () => {
  it('история доходит до прошлого месяца: незакрытые приходят с closed = false', async () => {
    const { call } = setup();
    const { base } = await ledger(call);
    const ym = new Date().toISOString().slice(0, 7);
    const prev = shiftYmTest(ym, -1);
    const start = shiftYmTest(ym, -2);
    await call(1, 'PATCH', base, { startYm: start });
    expect((await call(1, 'POST', `${base}/months/${start}/close`)).status).toBe(200);
    const months = (await call(1, 'GET', `${base}/history`)).body.months.map((m: any) => [m.ym, m.closed]);
    expect(months).toEqual([[start, true], [prev, false]]);
  });
});

describe('переносы остатков и архивация фондов', () => {
  // Октябрь закрыт, ноябрь текущий: так видно и пересчёт закрытых месяцев, и снятие плана
  async function start() {
    const ctx = setup();
    const l = await ledger(ctx.call);
    const call = ctx.call;
    const { base, fund } = l;
    const ym = new Date().toISOString().slice(0, 7);
    const prev = shiftYmTest(ym, -1);
    await call(1, 'PATCH', base, { startYm: prev });
    await call(1, 'PUT', `${base}/plans/${prev}`, { items: [{ fundId: fund('Авто'), amount: k(30_000) }, { fundId: fund('Еда'), amount: k(100_000) }] });
    await call(1, 'POST', `${base}/entries`, { date: `${prev}-05`, kind: 'income', amount: k(500_000) });
    await call(1, 'POST', `${base}/entries`, { date: `${prev}-06`, kind: 'expense', amount: k(10_000), fundId: fund('Авто'), comment: 'мойка' });
    await call(1, 'POST', `${base}/entries`, { date: `${prev}-07`, kind: 'expense', amount: k(5_000), fundId: fund('Авто'), comment: 'омыватель' });
    expect((await call(1, 'POST', `${base}/months/${prev}/close`)).status).toBe(200);
    await call(1, 'PUT', `${base}/plans/${ym}`, { items: [{ fundId: fund('Авто'), amount: k(20_000) }, { fundId: fund('Еда'), amount: k(100_000) }] });
    const report = async (at = ym) => (await call(1, 'GET', `${base}/summary?ym=${at}`)).body.report;
    const balance = async (name: string, at = ym) => (await report(at)).funds.find((f: any) => f.id === fund(name))?.balanceAfter ?? 0;
    return { ...ctx, ...l, ym, prev, report, balance };
  }

  it('перенос остатка меняет только остатки, «Деньги» те же; в закрытом месяце нужен пересчёт', async () => {
    const { call, base, fund, ym, prev, report, balance } = await start();
    const before = await report();
    await call(1, 'POST', `${base}/transfers`, { date: `${ym}-02`, amount: k(7_000), fromFundId: fund('Авто'), toFundId: fund('Еда'), comment: 'лишнее' });
    await call(1, 'POST', `${base}/transfers`, { date: `${ym}-02`, amount: k(3_000), fromFundId: fund('Авто'), toFundId: null });
    const after = await report();
    expect(await balance('Авто')).toBe(k(30_000 - 15_000 + 20_000 - 10_000));
    expect(after.freeAfter - before.freeAfter).toBe(k(3_000));
    expect(after.moneyAfter).toBe(before.moneyAfter);
    expect(after.plannedTotal).toBe(before.plannedTotal);
    expect(after.transfers).toBe(k(3_000));
    // Закрытый месяц: только с согласием, и в журнал
    expect((await call(1, 'POST', `${base}/transfers`, { date: `${prev}-20`, amount: k(1_000), fromFundId: null, toFundId: fund('Еда') })).status).toBe(409);
    const id = (await call(1, 'POST', `${base}/transfers`, { date: `${prev}-20`, amount: k(1_000), fromFundId: null, toFundId: fund('Еда'), recalc: true })).body.id;
    expect((await call(1, 'GET', `${base}/changes`)).body[0]).toEqual(expect.objectContaining({ kind: 'transfer', action: 'create', fundAfter: 'Свободные → Еда' }));
    expect((await call(1, 'DELETE', `${base}/transfers/${id}`)).status).toBe(409);
    expect((await call(1, 'DELETE', `${base}/transfers/${id}?recalc=1`)).status).toBe(200);
    expect((await report(prev)).moneyAfter).toBe(before.moneyAfter - k(20_000 + 100_000 - 0) + k(20_000 + 100_000));
    expect((await call(1, 'POST', `${base}/transfers`, { date: `${ym}-02`, amount: k(1), fromFundId: null, toFundId: null })).status).toBe(400);
  });

  it('оставить историю: операции на месте, план снят, остаток в свободные; отмена всё возвращает', async () => {
    const { call, base, fund, ym, prev, report, balance } = await start();
    const before = await report();
    const preview = (await call(1, 'GET', `${base}/funds/${fund('Авто')}/archive`)).body;
    expect(preview).toEqual(expect.objectContaining({ balance: k(35_000), closedEntries: 2, empty: false }));
    expect((await call(1, 'POST', `${base}/funds/${fund('Авто')}/archive`, { mode: 'keep', balanceToFundId: null })).status).toBe(200);
    const after = await report();
    // План текущего месяца снят (20 000), остаток прошлого (15 000) ушёл в свободные: всего свободные +35 000
    expect(after.freeAfter - before.freeAfter).toBe(k(35_000));
    expect(after.moneyAfter).toBe(before.moneyAfter);
    expect(await balance('Авто')).toBe(0);
    // Прошлый месяц не меняется
    expect((await report(prev)).freeAfter).toBe(before.freeBefore);
    const funds = (await call(1, 'GET', `${base}/funds`)).body;
    expect(funds.find((f: any) => f.id === fund('Авто'))).toEqual(expect.objectContaining({ archived: 1, archive: expect.objectContaining({ mode: 'keep' }) }));
    // Перенос архивации руками не снимается
    const transfer = (await call(1, 'GET', `${base}/transfers`)).body[0];
    expect((await call(1, 'DELETE', `${base}/transfers/${transfer.id}`)).status).toBe(400);
    // Отмена: план и остаток как были
    expect((await call(1, 'POST', `${base}/funds/${fund('Авто')}/restore`, {})).body).toEqual({ skipped: 0 });
    const back = await report();
    expect(back.freeAfter).toBe(before.freeAfter);
    expect(await balance('Авто')).toBe(k(35_000));
    expect((await call(1, 'GET', `${base}/transfers`)).body).toEqual([]);
  });

  it('перенести всё: операции и планы переезжают, свободные ни в одном месяце не меняются; отмена с пересчётом', async () => {
    const { call, base, fund, ym, prev, report, balance } = await start();
    const before = { prev: await report(prev), now: await report() };
    const auto = fund('Авто'), food = fund('Еда');
    expect((await call(1, 'POST', `${base}/funds/${auto}/archive`, { mode: 'move', targetFundId: food })).status).toBe(409);
    expect((await call(1, 'POST', `${base}/funds/${auto}/archive`, { mode: 'move', targetFundId: food, recalc: true })).status).toBe(200);
    expect((await report(prev)).freeAfter).toBe(before.prev.freeAfter);
    expect((await report()).freeAfter).toBe(before.now.freeAfter);
    expect(await balance('Еда')).toBe(k(130_000 - 15_000 + 120_000));
    expect(await balance('Авто')).toBe(0);
    const comments = (await call(1, 'GET', `${base}/entries?ym=${prev}&fundId=${food}`)).body.map((e: any) => e.comment).sort();
    expect(comments).toEqual(['мойка', 'омыватель']);
    // Перенесённые операции закрытого месяца попали в журнал
    expect((await call(1, 'GET', `${base}/changes`)).body.filter((c: any) => c.kind === 'entry')).toHaveLength(2);
    // Одну операцию потом перенесли руками: отмена её не трогает
    const moved = (await call(1, 'GET', `${base}/entries?ym=${prev}&fundId=${food}`)).body.find((e: any) => e.comment === 'омыватель');
    await call(1, 'PUT', `${base}/entries/${moved.id}`, { ...moved, fundId: fund('Такси'), recalc: true });
    expect((await call(1, 'POST', `${base}/funds/${auto}/restore`, {})).status).toBe(409);
    expect((await call(1, 'POST', `${base}/funds/${auto}/restore`, { recalc: true })).body).toEqual({ skipped: 1 });
    expect(await balance('Авто')).toBe(k(35_000 + 5_000));
    expect(await balance('Еда')).toBe(k(200_000));
    expect((await report()).freeAfter).toBe(before.now.freeAfter);
  });

  it('разнести по фондам: план месяца идёт за операциями, остаток в выбранный фонд; пустой фонд архивируется сразу', async () => {
    const { call, base, fund, prev, report, balance } = await start();
    const before = await report();
    const entries = (await call(1, 'GET', `${base}/funds/${fund('Авто')}/archive`)).body.entries;
    const wash = entries.find((e: any) => e.comment === 'мойка').id;
    const res = await call(1, 'POST', `${base}/funds/${fund('Авто')}/archive`, {
      mode: 'split', targetFundId: fund('Такси'), balanceToFundId: fund('Еда'), assignments: [{ entryId: wash, fundId: fund('Еда') }], recalc: true,
    });
    expect(res.status).toBe(200);
    // Фонды-получатели получили операции вместе с планом: их остатки за прошлый месяц не изменились
    expect(await balance('Такси', prev)).toBe(0);
    expect(await balance('Еда', prev)).toBe(k(100_000));
    // План Авто текущего месяца (20 000) снят и ушёл в свободные, остаток прошлого (15 000) переехал в Еду
    expect(await balance('Еда')).toBe(k(200_000 + 15_000));
    expect((await report()).freeAfter).toBe(before.freeAfter + k(20_000));
    expect((await report()).moneyAfter).toBe(before.moneyAfter);
    // Пустой фонд: сразу, и через старый PATCH тоже; с операциями PATCH отказывает
    expect((await call(1, 'POST', `${base}/funds/${fund('Подарки')}/archive`, { mode: 'keep' })).status).toBe(200);
    expect((await call(1, 'PATCH', `${base}/funds/${fund('Подарки')}`, { archived: false })).status).toBe(200);
    expect((await call(1, 'PATCH', `${base}/funds/${fund('Подарки')}`, { archived: true })).status).toBe(200);
    expect((await call(1, 'PATCH', `${base}/funds/${fund('Еда')}`, { archived: true })).status).toBe(400);
  });
});

describe('записи не удаляются', () => {
  it('операция, выплата и корректировка получают отметку и выходят из расчётов', async () => {
    const { db, call } = setup();
    const { base, fund } = await ledger(call);
    const invite = (await call(1, 'POST', `${base}/invites`)).body;
    await call(2, 'POST', '/api/invites/accept', { token: invite.token });
    const income = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-01', kind: 'income', amount: k(1000), earnedBy: 1 })).body.id;
    const expense = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-02', kind: 'expense', amount: k(100), fundId: fund('Еда'), paidBy: 2, tags: ['кофе'] })).body.id;
    const settlement = (await call(1, 'POST', `${base}/settlements`, { userId: 2, date: '2026-10-03', amount: k(40) })).body.id;
    const adjustment = (await call(1, 'POST', `${base}/adjustments`, { date: '2026-10-04', amount: k(5), comment: 'сверка' })).body.id;

    const summary = async () => (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body;
    expect((await summary()).debts.find((d: any) => d.userId === 2).owed).toBe(k(60));
    expect((await call(1, 'DELETE', `${base}/settlements/${settlement}`)).status).toBe(200);
    expect((await summary()).debts.find((d: any) => d.userId === 2).owed).toBe(k(100));
    expect((await call(1, 'DELETE', `${base}/entries/${expense}`)).status).toBe(200);
    expect((await call(1, 'DELETE', `${base}/entries/${income}`)).status).toBe(200);
    expect((await call(1, 'DELETE', `${base}/adjustments/${adjustment}`)).status).toBe(200);

    const { report, debts } = await summary();
    expect(report).toMatchObject({ income: 0, spentTotal: 0, adjustments: 0 });
    expect(debts.every((d: any) => d.owed === 0)).toBe(true);
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body).toEqual([]);
    expect((await call(1, 'GET', `${base}/settlements`)).body).toEqual([]);
    expect((await call(1, 'GET', `${base}/adjustments`)).body).toEqual([]);
    expect((await call(1, 'GET', `${base}/incomes`)).body).toEqual([]);
    expect((await call(1, 'GET', `${base}/tags/stats`)).body.rows).toEqual([]);
    expect((await call(1, 'GET', `${base}/tags`)).body[0].count).toBe(0);
    expect((await call(1, 'PUT', `${base}/entries/${expense}`, { date: '2026-10-02', kind: 'expense', amount: k(1), fundId: fund('Еда') })).status).toBe(404);
    expect((await call(1, 'DELETE', `${base}/entries/${expense}`)).status).toBe(404);

    for (const [table, id] of [['entries', expense], ['entries', income], ['settlements', settlement], ['adjustments', adjustment]] as const) {
      const row = db.prepare(`SELECT inactive_at FROM ${table} WHERE id = ?`).get(id) as { inactive_at: string };
      expect(row.inactive_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    const firstMark = (db.prepare('SELECT inactive_at FROM settlements WHERE id = ?').get(settlement) as any).inactive_at;
    await call(1, 'DELETE', `${base}/settlements/${settlement}`);
    expect((db.prepare('SELECT inactive_at FROM settlements WHERE id = ?').get(settlement) as any).inactive_at).toBe(firstMark);
  });

  it('убранный участник теряет доступ, а новое приглашение его возвращает', async () => {
    const { db, call } = setup();
    const { base } = await ledger(call);
    const invite = async () => (await call(1, 'POST', `${base}/invites`)).body.token;
    await call(2, 'POST', '/api/invites/accept', { token: await invite() });
    expect((await call(1, 'DELETE', `${base}/members/2`)).status).toBe(200);
    expect((await call(2, 'GET', `${base}/funds`)).status).toBe(403);
    expect((await call(2, 'GET', '/api/me')).body.ledgers).toEqual([]);
    expect((await call(1, 'GET', `${base}/members`)).body.map((m: any) => m.userId)).toEqual([1]);
    expect((db.prepare('SELECT inactive_at FROM members WHERE user_id = 2').get() as any).inactive_at).toBeTruthy();

    await call(2, 'POST', '/api/invites/accept', { token: await invite() });
    expect((await call(2, 'GET', `${base}/funds`)).status).toBe(200);
  });

  it('удалённый тег скрыт, его можно создать снова, виртуальный участник остаётся в базе после связи', async () => {
    const { db, call } = setup();
    const { base, fund } = await ledger(call);
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-02', kind: 'expense', amount: k(100), fundId: fund('Еда'), tags: ['кофе'] });
    const tag = (await call(1, 'GET', `${base}/tags`)).body[0];
    await call(1, 'DELETE', `${base}/tags/${tag.id}`);
    expect((await call(1, 'GET', `${base}/tags`)).body).toEqual([]);
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body[0].tags).toEqual([]);
    expect((await call(1, 'GET', `${base}/tags/stats`)).body.untagged).toEqual([{ ym: '2026-10', total: k(100) }]);
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-03', kind: 'expense', amount: k(100), fundId: fund('Еда'), tags: ['кофе'] });
    expect((await call(1, 'GET', `${base}/tags`)).body.map((t: any) => t.name)).toEqual(['кофе']);

    const virtual = (await call(1, 'POST', `${base}/members/virtual`, { name: 'Анна' })).body.userId;
    const token = (await call(1, 'POST', `${base}/invites`)).body.token;
    await call(2, 'POST', '/api/invites/accept', { token });
    await call(1, 'POST', `${base}/members/${virtual}/link`, { userId: 2 });
    expect((await call(1, 'GET', `${base}/members`)).body.map((m: any) => m.userId).sort()).toEqual([1, 2]);
    expect((db.prepare('SELECT inactive_at FROM members WHERE user_id = ?').get(virtual) as any).inactive_at).toBeTruthy();
    expect(db.prepare('SELECT 1 x FROM users WHERE id = ?').get(virtual)).toBeTruthy();
  });
});

describe('настройки базы', () => {
  it('заблокированная база только читается', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    await call(1, 'PUT', `${base}/plans/2026-10`, { items: [{ fundId: fund('Еда'), amount: k(100) }] });
    expect((await call(1, 'PATCH', base, { locked: true })).status).toBe(200);
    expect((await call(1, 'GET', '/api/me')).body.ledgers[0]).toMatchObject({ locked: true });

    const blocked = await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(10), fundId: fund('Еда') });
    expect(blocked.status).toBe(423);
    expect(blocked.body.error).toMatch(/заблокирована/);
    expect((await call(1, 'POST', `${base}/adjustments`, { date: '2026-10-05', amount: k(1), comment: 'x' })).status).toBe(423);
    expect((await call(1, 'PATCH', base, { name: 'Другое' })).status).toBe(423);
    expect((await call(1, 'GET', `${base}/summary?ym=2026-10`)).status).toBe(200);
    // Оформление личное и от блокировки базы не зависит
    expect((await call(1, 'PATCH', '/api/me', { theme: 'ocean', design: 'unlocked' })).status).toBe(200);
    expect((await call(1, 'GET', '/api/me')).body.user).toMatchObject({ theme: 'ocean', design: 'unlocked' });
    expect((await call(2, 'GET', '/api/me')).body.user).toMatchObject({ theme: 'sky', themeMode: 'telegram', design: '' });
    expect((await call(1, 'PATCH', '/api/me', { design: 'другой' })).status).toBe(400);
    expect((await call(1, 'PATCH', '/api/me', { theme: 'нет такой' })).status).toBe(400);

    expect((await call(1, 'PATCH', base, { locked: false })).status).toBe(200);
    expect((await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(10), fundId: fund('Еда') })).status).toBe(200);
  });
});

describe('корректировки', () => {
  it('правятся с тегами, а в закрытом месяце меняются только причина и теги', async () => {
    const { call } = setup();
    const { base } = await ledger(call);
    const { body } = await call(1, 'POST', `${base}/adjustments`, { date: '2026-10-04', amount: k(5), comment: 'сверка', tags: ['#Кешбек'] });
    const list = async () => (await call(1, 'GET', `${base}/adjustments`)).body;
    expect(await list()).toEqual([{ id: body.id, date: '2026-10-04', amount: k(5), comment: 'сверка', closed: false, tags: ['кешбек'] }]);

    expect((await call(1, 'PUT', `${base}/adjustments/${body.id}`, { date: '2026-10-10', amount: k(-7), comment: 'пересчёт', tags: ['касса'] })).status).toBe(200);
    expect(await list()).toMatchObject([{ date: '2026-10-10', amount: k(-7), comment: 'пересчёт', tags: ['касса'] }]);
    const free = async () => (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body.report.adjustments;
    expect(await free()).toBe(k(-7));
    const tags = (await call(1, 'GET', `${base}/tags`)).body;
    expect(tags.find((t: any) => t.name === 'касса').count).toBe(1);
    expect(tags.find((t: any) => t.name === 'кешбек').count).toBe(0);

    await call(1, 'POST', `${base}/months/2026-10/close`);
    expect((await list())[0].closed).toBe(true);
    expect((await call(1, 'PUT', `${base}/adjustments/${body.id}`, { date: '2026-10-10', amount: k(-8), comment: 'пересчёт', tags: [] })).status).toBe(409);
    expect((await call(1, 'PUT', `${base}/adjustments/${body.id}`, { date: '2026-11-01', amount: k(-7), comment: 'пересчёт', tags: [] })).status).toBe(409);
    expect((await call(1, 'PUT', `${base}/adjustments/${body.id}`, { date: '2026-10-10', amount: k(-7), comment: 'кешбек', tags: ['кешбек'] })).status).toBe(200);
    expect(await list()).toMatchObject([{ amount: k(-7), comment: 'кешбек', tags: ['кешбек'] }]);
    expect(await free()).toBe(k(-7));

    // С согласием на пересчёт закрытый месяц меняется, а остаётся закрытым
    expect((await call(1, 'PUT', `${base}/adjustments/${body.id}`, { date: '2026-10-12', amount: k(20), comment: 'кешбек', tags: ['кешбек'], recalc: true })).status).toBe(200);
    expect(await free()).toBe(k(20));
    expect((await list())[0]).toMatchObject({ date: '2026-10-12', closed: true });
    expect((await call(1, 'PUT', `${base}/adjustments/${body.id}`, { date: '2026-09-30', amount: k(20), comment: 'кешбек', tags: [], recalc: true })).status).toBe(400);
  });

  it('операцию закрытого месяца администратор меняет и удаляет с пересчётом', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const invite = (await call(1, 'POST', `${base}/invites`)).body;
    await call(2, 'POST', '/api/invites/accept', { token: invite.token });
    const own = (await call(2, 'POST', `${base}/entries`, { date: '2026-10-02', kind: 'expense', amount: k(50), fundId: fund('Еда') })).body.id;
    const id = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(100), fundId: fund('Еда') })).body.id;
    await call(1, 'POST', `${base}/months/2026-10/close`);
    const spent = async () => (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body.report.spentTotal;
    const edit = (user: number, entry: number, recalc?: boolean) =>
      call(user, 'PUT', `${base}/entries/${entry}`, { date: '2026-10-05', kind: 'expense', amount: k(300), fundId: fund('Еда'), ...(recalc ? { recalc } : {}) });

    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body[0].closed).toBe(true);
    expect((await edit(1, id)).status).toBe(409);
    expect((await edit(2, own, true)).status).toBe(409);
    expect((await edit(1, id, true)).status).toBe(200);
    expect(await spent()).toBe(k(350));
    expect((await call(1, 'DELETE', `${base}/entries/${id}`)).status).toBe(409);
    expect((await call(1, 'DELETE', `${base}/entries/${id}?recalc=1`)).status).toBe(200);
    expect(await spent()).toBe(k(50));
  });
});

describe('журнал изменений закрытых месяцев', () => {
  it('записывает правку, удаление и добавление и откатывает их', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const id = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(100), fundId: fund('Еда'), comment: 'рынок', tags: ['овощи'] })).body.id;
    const open = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(10), fundId: fund('Еда') })).body.id;
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-07', kind: 'expense', amount: k(1), fundId: fund('Еда') });
    await call(1, 'POST', `${base}/months/2026-10/close`);
    const spent = async () => (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body.report.spentTotal;
    const changes = async () => (await call(1, 'GET', `${base}/changes`)).body;
    expect(await changes()).toEqual([]);

    await call(1, 'PUT', `${base}/entries/${id}`, { date: '2026-10-05', kind: 'expense', amount: k(300), fundId: fund('Еда'), comment: 'рынок', tags: ['фрукты'], recalc: true });
    await call(1, 'DELETE', `${base}/entries/${open}?recalc=1`);
    const added = (await call(1, 'POST', `${base}/adjustments`, { date: '2026-10-08', amount: k(5), comment: 'сверка', recalc: true })).body.id;
    expect(await spent()).toBe(k(301));
    const [create, remove, edit] = await changes();
    expect(edit).toMatchObject({ kind: 'entry', action: 'update', userName: expect.any(String), fundBefore: 'Еда', before: { amount: k(100), tags: ['овощи'] }, after: { amount: k(300), tags: ['фрукты'] } });
    expect(remove).toMatchObject({ action: 'delete', after: null });
    expect(create).toMatchObject({ kind: 'adjustment', action: 'create', before: null, recordId: added });

    // Откат правки, после которой запись меняли снова, запрещён
    await call(1, 'PUT', `${base}/entries/${id}`, { date: '2026-10-05', kind: 'expense', amount: k(400), fundId: fund('Еда'), comment: 'рынок', tags: ['фрукты'], recalc: true });
    expect((await call(1, 'POST', `${base}/changes/${edit.id}/revert`)).status).toBe(400);
    const latest = (await changes())[0];
    expect((await call(1, 'POST', `${base}/changes/${latest.id}/revert`)).status).toBe(200);
    expect((await call(1, 'POST', `${base}/changes/${edit.id}/revert`)).status).toBe(200);
    expect((await call(1, 'POST', `${base}/changes/${edit.id}/revert`)).status).toBe(400);
    expect((await call(1, 'POST', `${base}/changes/${remove.id}/revert`)).status).toBe(200);
    expect((await call(1, 'POST', `${base}/changes/${create.id}/revert`)).status).toBe(200);
    expect(await spent()).toBe(k(111));
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body.find((e: any) => e.id === id).tags).toEqual(['овощи']);
    expect((await call(1, 'GET', `${base}/adjustments`)).body).toEqual([]);
    expect((await changes()).every((c: any) => c.revertedAt)).toBe(true);
  });
});

describe('виртуальные участники', () => {
  async function start() {
    const ctx = setup();
    const l = await ledger(ctx.call);
    const virtual = (await ctx.call(1, 'POST', `${l.base}/members/virtual`, { name: 'Анна' })).body.userId;
    await ctx.call(1, 'POST', `${l.base}/entries`, { date: '2026-10-05', kind: 'income', amount: k(500), earnedBy: virtual });
    await ctx.call(1, 'POST', `${l.base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(100), fundId: l.fund('Еда'), paidBy: virtual });
    await ctx.call(1, 'POST', `${l.base}/settlements`, { userId: virtual, date: '2026-10-06', amount: k(40) });
    return { ...ctx, ...l, virtual };
  }
  const debt = async (call: any, base: string, id: number) => (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body.debts.find((d: any) => d.userId === id)?.owed;

  it('копит доходы и долги, но не входит и не становится админом', async () => {
    const { call, base, virtual } = await start();
    expect(virtual).toBeLessThan(0);
    expect(await debt(call, base, virtual)).toBe(k(60));
    expect((await call(1, 'PATCH', `${base}/members/${virtual}`, { role: 'admin' })).status).toBe(400);
    expect((await call(2, 'POST', `${base}/members/virtual`, { name: 'Чужой' })).status).toBe(403);
    // Заголовок с минусом не считается входом
    const res = await call(1, 'GET', `${base}/members`);
    expect(res.body.some((m: any) => m.userId === virtual && m.name === 'Анна')).toBe(true);
  });

  it('показывает аккаунт настоящего участника, а у виртуального его нет', async () => {
    const { db, call, base, virtual } = await start();
    const members = async () => (await call(1, 'GET', `${base}/members`)).body;
    expect((await members()).find((m: any) => m.userId === 1).account).toBe('Тест 1');
    db.prepare('UPDATE users SET username = ? WHERE id = 1').run('igor');
    expect((await members()).find((m: any) => m.userId === 1).account).toBe('@igor');
    expect((await members()).find((m: any) => m.userId === virtual).account).toBeNull();
  });

  it('связывается по одноразовой ссылке и передаёт историю', async () => {
    const { call, base, virtual } = await start();
    const invite = (await call(1, 'POST', `${base}/members/${virtual}/link-invite`)).body;
    expect((await call(2, 'POST', '/api/invites/accept', { token: invite.token })).status).toBe(200);

    const members = (await call(1, 'GET', `${base}/members`)).body;
    expect(members.find((m: any) => m.userId === 2).name).toBe('Анна');
    expect(members.some((m: any) => m.userId === virtual)).toBe(false);
    expect(await debt(call, base, 2)).toBe(k(60));
    const incomes = (await call(1, 'GET', `${base}/incomes`)).body;
    expect(incomes).toMatchObject([{ userId: 2, total: k(500) }]);
    expect((await call(3, 'POST', '/api/invites/accept', { token: invite.token })).status).toBe(404);
  });

  it('связывается с уже вступившим участником, чужую базу не трогает', async () => {
    const { call, base, virtual } = await start();
    const invite = (await call(1, 'POST', `${base}/invites`)).body;
    await call(2, 'POST', '/api/invites/accept', { token: invite.token });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-07', kind: 'expense', amount: k(10), fundId: (await call(1, 'GET', `${base}/funds`)).body[0].id, paidBy: 2 });

    expect((await call(2, 'POST', `${base}/members/${virtual}/link`, { userId: 2 })).status).toBe(403);
    expect((await call(1, 'POST', `${base}/members/${virtual}/link`, { userId: 99 })).status).toBe(404);
    expect((await call(1, 'POST', `${base}/members/2/link`, { userId: 1 })).status).toBe(400);

    const other = (await call(5, 'POST', '/api/ledgers', { name: 'Чужая', startYm: '2026-10' }));
    expect(other.status).toBe(403);
    expect((await call(1, 'POST', `${base}/members/${virtual}/link`, { userId: 2 })).status).toBe(200);
    expect(await debt(call, base, 2)).toBe(k(70));
    expect((await call(1, 'GET', `${base}/members`)).body.map((m: any) => m.userId).sort()).toEqual([1, 2]);
    expect((await call(1, 'POST', `${base}/members/${virtual}/link`, { userId: 2 })).status).toBe(404);
  });
});

describe('доходы участников', () => {
  it('привязывает доход к участнику из формы и выписки и считает по месяцам', async () => {
    const { db, call } = setup();
    const { base, fund } = await ledger(call);
    const invite = (await call(1, 'POST', `${base}/invites`)).body;
    await call(2, 'POST', '/api/invites/accept', { token: invite.token });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'income', amount: k(1000), earnedBy: 1 });
    const second = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'income', amount: k(300), earnedBy: 2 })).body.id;
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-07', kind: 'income', amount: k(50) });
    expect((await call(1, 'POST', `${base}/entries`, { date: '2026-10-07', kind: 'income', amount: k(50), earnedBy: 99 })).status).toBe(404);
    // У расхода поле не сохраняется, а долг участника доход не создаёт
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-08', kind: 'expense', amount: k(10), fundId: fund('Еда'), earnedBy: 2 });

    const ledgerId = Number(base.split('/').pop());
    const row: StatementRow = { hash: 'i', bank: 'kaspi', account: '1', date: '2026-11-02', amount: k(70), currency: 'KZT', op: 'Пополнение', details: 'ТОО', pending: false };
    const batch = await createImportFromRows(db, async () => new Map(), ledgerId, 1, ['a.pdf'], [row], []);
    const rowId = (await call(1, 'GET', `${base}/imports/${batch}`)).body.rows[0].id;
    await call(1, 'POST', `${base}/imports/${batch}/decide`, { decisions: [{ rowId, action: 'income', earnedBy: 2 }] });

    const stats = (await call(1, 'GET', `${base}/incomes`)).body;
    const total = (ym: string, userId: number | null) => stats.find((r: any) => r.ym === ym && r.userId === userId)?.total;
    expect([total('2026-10', 1), total('2026-10', 2), total('2026-10', null), total('2026-11', 2)]).toEqual([k(1000), k(300), k(50), k(70)]);
    expect((await call(2, 'GET', `${base}/incomes`)).status).toBe(200);
    expect((await call(3, 'GET', `${base}/incomes`)).status).toBe(403);

    const list = (await call(1, 'GET', `${base}/entries?ym=2026-10`)).body;
    expect(list.find((e: any) => e.id === second).earnedBy).toBe(2);
    expect(list.find((e: any) => e.kind === 'expense').earnedBy).toBeNull();
    const debts = (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body.debts;
    expect(debts.every((d: any) => d.owed === 0)).toBe(true);
  });
});

describe('предупреждение о темпе трат', () => {
  it('сравнивает с лимитом на отметках месяца и отключается галочкой', async () => {
    const { db, call } = setup();
    const { base, fund } = await ledger(call);
    const id = Number(base.split('/').pop());
    await call(1, 'PUT', `${base}/plans/2026-10`, { items: [{ fundId: fund('Еда'), amount: k(100000) }, { fundId: fund('Кафе'), amount: k(100000) }] });
    const spend = (date: string, name: string, amount: number) => call(1, 'POST', `${base}/entries`, { date, kind: 'expense', amount: k(amount), fundId: fund(name) });
    await spend('2026-10-05', 'Еда', 40000);
    await spend('2026-10-05', 'Кафе', 25000);
    await spend('2026-10-09', 'Кафе', 50000);

    // Отметка 25% в октябре приходится на 8 число; до неё предупреждать рано
    expect(paceAlerts(db, id, '2026-10', '2026-10-07')).toEqual([]);
    // Ровно норма не считается превышением, траты после отметки не учитываются
    expect(paceAlerts(db, id, '2026-10', '2026-10-10')).toMatchObject([{ name: 'Еда', checkpoint: 25, day: 8, runOutDay: 20 }]);
    // На отметке 50% (16 число) Кафе потратило 75%, а Еда с её 40% вернулась в норму
    expect(paceAlerts(db, id, '2026-10', '2026-10-16').map((a) => a.name)).toEqual(['Кафе']);
    expect(paceAlerts(db, id, '2026-11', '2026-10-16')).toEqual([]);

    await call(1, 'PATCH', `${base}/funds/${fund('Кафе')}`, { paceAlert: false });
    expect(paceAlerts(db, id, '2026-10', '2026-10-16')).toEqual([]);
    await call(1, 'PATCH', `${base}/funds/${fund('Кафе')}`, { paceAlert: true });

    await spend('2026-10-10', 'Кафе', 30000);
    expect(paceAlerts(db, id, '2026-10', '2026-10-16')[0].runOutDay).toBeNull();
    await call(1, 'POST', `${base}/months/2026-10/close`);
    expect(paceAlerts(db, id, '2026-10', '2026-10-16')).toEqual([]);
  });
});

describe('теги', () => {
  const row = (hash: string, details: string, over: Partial<StatementRow> = {}): StatementRow => ({
    hash, bank: 'kaspi', account: '1', date: '2026-10-10', amount: -100000, currency: 'KZT', op: 'Покупка', details, pending: false, ...over,
  });

  it('приводятся к одному виду, попадают в статистику и не меняют суммы', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const first = await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(1000), fundId: fund('Еда'), comment: 'Рынок', tags: [' #Дети ', 'дети', 'Отпуск'] });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(500), fundId: fund('Еда') });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-07', kind: 'expense', amount: -k(200), fundId: fund('Еда'), tags: ['дети'] });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-07', kind: 'income', amount: k(9000), tags: ['дети'] });

    const list = (await call(1, 'GET', `${base}/entries?ym=2026-10`)).body;
    expect(list.find((e: any) => e.id === first.body.id).tags.sort()).toEqual(['дети', 'отпуск']);
    // Теги есть и у доходов, но статистика тегов считает только траты
    expect(list.find((e: any) => e.kind === 'income').tags).toEqual(['дети']);

    const stats = (await call(1, 'GET', `${base}/tags/stats`)).body;
    expect(stats.rows.find((r: any) => r.name === 'дети').total).toBe(k(800));
    expect(stats.untagged).toEqual([{ ym: '2026-10', total: k(500) }]);

    const tags = (await call(1, 'GET', `${base}/tags`)).body;
    const kids = tags.find((t: any) => t.name === 'дети');
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10&tagId=${kids.id}`)).body).toHaveLength(3);
    const { report } = (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body;
    expect(report.spentTotal).toBe(k(1300));
  });

  it('правка без поля тегов их не стирает, удаление операции снимает тег', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const { body } = await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(100), fundId: fund('Еда'), tags: ['кофе'] });
    await call(1, 'PUT', `${base}/entries/${body.id}`, { date: '2026-10-05', kind: 'expense', amount: k(200), fundId: fund('Еда') });
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body[0].tags).toEqual(['кофе']);
    await call(1, 'DELETE', `${base}/entries/${body.id}`);
    expect((await call(1, 'GET', `${base}/tags`)).body[0].count).toBe(0);
  });

  it('переименование объединяет теги, управлять ими может только администратор', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(100), fundId: fund('Еда'), tags: ['кофе', 'кафе'] });
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-06', kind: 'expense', amount: k(100), fundId: fund('Еда'), tags: ['кафе'] });
    const tags = (await call(1, 'GET', `${base}/tags`)).body;
    const coffee = tags.find((t: any) => t.name === 'кофе');
    const invite = (await call(1, 'POST', `${base}/invites`)).body;
    await call(2, 'POST', '/api/invites/accept', { token: invite.token });
    expect((await call(2, 'DELETE', `${base}/tags/${coffee.id}`)).status).toBe(403);

    expect((await call(1, 'PATCH', `${base}/tags/${coffee.id}`, { name: 'Кафе' })).status).toBe(200);
    expect((await call(1, 'GET', `${base}/tags`)).body.map((t: any) => [t.name, t.count])).toEqual([['кафе', 2]]);
  });

  it('ручная операция получает теги прошлой с тем же комментарием', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(100), fundId: fund('Спорт'), comment: 'Бассейн', tags: ['здоровье'] });
    const res = (await call(1, 'GET', `${base}/tags/suggest?fundId=${fund('Спорт')}&text=${encodeURIComponent('бассейн')}`)).body;
    expect(res).toEqual({ auto: ['здоровье'], frequent: ['здоровье'] });
    expect((await call(1, 'GET', `${base}/tags/suggest?text=${encodeURIComponent('другое')}`)).body.auto).toEqual([]);
  });

  it('выписка: теги новому продавцу даёт AI, затем они берутся из истории', async () => {
    const { db, call } = setup();
    const { base, fund } = await ledger(call);
    const ledgerId = Number(base.split('/').pop());
    const asked: string[][] = [];
    const suggester = async (merchants: string[]) => {
      asked.push(merchants);
      return new Map(merchants.map((m) => [m, { fundId: fund('Кафе'), tags: ['Кофе', 'Кафе'] }]));
    };
    const first = await createImportFromRows(db, suggester, ledgerId, 1, ['a.pdf'], [row('a', 'COFFEE BOOM')], []);
    const batch = (await call(1, 'GET', `${base}/imports/${first}`)).body;
    // Тег, повторяющий название фонда, отбрасывается
    expect(batch.rows[0].suggestedTags).toEqual(['кофе']);
    await call(1, 'POST', `${base}/imports/${first}/decide`, {
      decisions: [{ rowId: batch.rows[0].id, action: 'expense', tags: ['кофе'], parts: [{ fundId: fund('Кафе'), amount: 60000 }, { fundId: fund('Еда'), amount: 40000 }] }],
    });
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body.every((e: any) => e.tags[0] === 'кофе')).toBe(true);

    const second = await createImportFromRows(db, suggester, ledgerId, 1, ['b.pdf'], [row('b', 'COFFEE BOOM', { date: '2026-10-11' })], []);
    expect((await call(1, 'GET', `${base}/imports/${second}`)).body.rows[0].suggestedTags).toEqual(['кофе']);
    expect(asked).toHaveLength(1);
  });
});

describe('операции в обработке', () => {
  const stmtRow = (over: Partial<StatementRow>): StatementRow => ({
    hash: 'h1', bank: 'freedom', account: '1111', date: '2026-10-30', amount: -50000, currency: 'KZT', op: 'Сумма в обработке', details: 'OZON ALMATY KZ', pending: true, ...over,
  });

  async function start() {
    const ctx = setup();
    const l = await ledger(ctx.call);
    const ledgerId = Number(l.base.split('/').pop());
    const upload = (rows: StatementRow[]) => createImportFromRows(ctx.db, async () => new Map(), ledgerId, 1, ['test.pdf'], rows, []);
    return { ...ctx, ...l, upload };
  }

  it('внесённая операция в обработке не дублируется, когда банк её проводит', async () => {
    const { call, base, fund, upload } = await start();
    const first = await upload([stmtRow({})]);
    const batch = (await call(1, 'GET', `${base}/imports/${first}`)).body;
    expect(batch.rows).toHaveLength(1);
    await call(1, 'POST', `${base}/imports/${first}/decide`, {
      decisions: [{ rowId: batch.rows[0].id, action: 'expense', parts: [{ fundId: fund('Еда'), amount: 50000 }] }],
    });

    const finalRow = stmtRow({ hash: 'h2', date: '2026-10-31', op: 'Покупка', pending: false });
    const second = (await call(1, 'GET', `${base}/imports/${await upload([finalRow])}`)).body;
    // Проведённая операция видна, но сразу отмечена «Пропустить»
    expect(second.rows).toMatchObject([{ suggestedAction: 'skip' }]);
    expect(second.rows[0].hint).toContain('в обработке');
    expect(second.warnings.join(' ')).toContain('Проведены банком');
    await call(1, 'POST', `${base}/imports/${second.id}/decide`, { decisions: [{ rowId: second.rows[0].id, action: 'skip' }] });

    const third = (await call(1, 'GET', `${base}/imports/${await upload([finalRow])}`)).body;
    expect(third.rows).toMatchObject([{ suggestedAction: 'skip' }]);
    expect(third.rows[0].hint).toContain('Уже была в выписке');
    const { report } = (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body;
    expect(report.spentTotal).toBe(50000);
  });

  it('другая сумма или дальняя дата считаются новой операцией', async () => {
    const { call, base, upload } = await start();
    await upload([stmtRow({})]);
    const other = stmtRow({ hash: 'h3', amount: -49000, op: 'Покупка', pending: false });
    const far = stmtRow({ hash: 'h4', date: '2026-12-01', op: 'Покупка', pending: false });
    const batch = (await call(1, 'GET', `${base}/imports/${await upload([other, far])}`)).body;
    expect(batch.rows).toHaveLength(2);
  });

  it('банк провёл сумму за вычетом объединённого возврата: это та же операция', async () => {
    const { call, base, fund, upload } = await start();
    const first = await upload([
      stmtRow({ amount: -4539878, details: 'Wolt Helsinki FI' }),
      stmtRow({ hash: 'r1', amount: 198023, op: 'Покупка', details: 'Возврат. Отмена покупки', pending: false }),
    ]);
    const batch = (await call(1, 'GET', `${base}/imports/${first}`)).body;
    const wolt = batch.rows.find((r: any) => r.amount < 0);
    const refund = batch.rows.find((r: any) => r.amount > 0);
    await call(1, 'POST', `${base}/imports/${first}/decide`, {
      decisions: [
        { rowId: wolt.id, action: 'expense', parts: [{ fundId: fund('Еда'), amount: 4341855 }] },
        { rowId: refund.id, action: 'merge', intoRowId: wolt.id },
      ],
    });
    const settled = stmtRow({ hash: 'h6', amount: -4341855, details: 'Wolt Helsinki FI', op: 'Покупка', pending: false });
    const refundAgain = stmtRow({ hash: 'r1', amount: 198023, op: 'Покупка', details: 'Возврат. Отмена покупки', pending: false });
    const second = (await call(1, 'GET', `${base}/imports/${await upload([settled, refundAgain])}`)).body;
    expect(second.rows).toHaveLength(2);
    expect(second.rows.every((r: any) => r.suggestedAction === 'skip')).toBe(true);
  });

  it('проведённая сумма отличается: операция новая, но с подсказкой сверить', async () => {
    const { call, base, upload } = await start();
    await upload([stmtRow({})]);
    const changed = stmtRow({ hash: 'h7', amount: -52000, op: 'Покупка', pending: false });
    const batch = (await call(1, 'GET', `${base}/imports/${await upload([changed])}`)).body;
    expect(batch.rows).toMatchObject([{ suggestedAction: 'expense' }]);
    expect(batch.rows[0].hint).toContain('банк мог изменить сумму');
  });

  it('банк дописал хвост к продавцу: операция всё равно сопоставляется с той, что в обработке', async () => {
    const { call, base, upload } = await start();
    await upload([stmtRow({ details: 'GOOGLE Unknown Worlds MOUNTAIN VIEW US' })]);
    const settled = stmtRow({ hash: 'h5', details: 'GOOGLE Unknown Worlds MOUNTAIN VIEW', op: 'Покупка', pending: false });
    const batch = (await call(1, 'GET', `${base}/imports/${await upload([settled])}`)).body;
    expect(batch.rows).toMatchObject([{ suggestedAction: 'skip' }]);
  });
});

describe('доступ только по приглашению', () => {
  it('новый человек не создаёт базу, приглашённый может, а чужое приглашение не подходит', async () => {
    const { call } = setup();
    const stranger = await call(9, 'GET', '/api/me');
    expect(stranger.body).toMatchObject({ canCreateLedger: false, ledgers: [] });
    expect((await call(9, 'POST', '/api/ledgers', { name: 'Чужая' })).status).toBe(403);
    expect((await call(9, 'POST', '/api/invites/accept', { token: 'неверный-токен' })).status).toBe(404);

    const { base } = await ledger(call);
    const { token } = (await call(1, 'POST', `${base}/invites`)).body;
    expect((await call(9, 'POST', '/api/invites/accept', { token })).status).toBe(200);
    expect((await call(9, 'GET', '/api/me')).body.canCreateLedger).toBe(true);
    expect((await call(9, 'POST', '/api/ledgers', { name: 'Своя' })).status).toBe(200);
  });
});

describe('приглашение в сервис', () => {
  it('даёт одному человеку право создать базу и не открывает чужую', async () => {
    const { call } = setup();
    const { base } = await ledger(call);
    const { token } = (await call(1, 'POST', '/api/service-invites')).body;

    const accepted = await call(9, 'POST', '/api/invites/accept', { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.ledgerId).toBeNull();
    const me = (await call(9, 'GET', '/api/me')).body;
    expect(me).toMatchObject({ canCreateLedger: true, isOwner: false, ledgers: [] });
    expect((await call(9, 'GET', `${base}/summary?ym=2026-10`)).status).toBe(403);
    expect((await call(9, 'POST', '/api/ledgers', { name: 'Своя' })).status).toBe(200);

    // Повторное открытие своей ссылкой не мешает, чужой человек ею уже не войдёт
    expect((await call(9, 'POST', '/api/invites/accept', { token })).status).toBe(200);
    expect((await call(8, 'POST', '/api/invites/accept', { token })).status).toBe(404);
    expect((await call(8, 'GET', '/api/me')).body.canCreateLedger).toBe(false);
  });

  it('создаёт только владелец, устаревшая ссылка не работает', async () => {
    const { call, db } = setup();
    const { base } = await ledger(call);
    const { token } = (await call(1, 'POST', `${base}/invites`)).body;
    await call(2, 'POST', '/api/invites/accept', { token });
    expect((await call(2, 'POST', '/api/service-invites')).status).toBe(403);

    const service = (await call(1, 'POST', '/api/service-invites')).body.token;
    db.prepare('UPDATE service_invites SET expires_at = 1 WHERE token = ?').run(service);
    expect((await call(9, 'POST', '/api/invites/accept', { token: service })).status).toBe(404);
    expect((await call(9, 'GET', '/api/me')).body.canCreateLedger).toBe(false);
  });
});

describe('приглашения', () => {
  it('ведут в Main Mini App и передают токен', async () => {
    const app = buildApp({ db: openDb(':memory:'), botToken: 'test', botUsername: 'demo_bot', devAuth: true, ownerIds: [1], suggestFunds: async () => new Map() });
    const headers = { 'x-dev-user': '1' };
    const { id } = (await app.inject({ method: 'POST', url: '/api/ledgers', headers, payload: { name: 'Семья' } })).json();
    const invite = (await app.inject({ method: 'POST', url: `/api/ledgers/${id}/invites`, headers, payload: {} })).json();
    expect(invite.link).toBe(`https://t.me/demo_bot?startapp=${invite.token}`);
  });
});

describe('вход через Telegram', () => {
  function sign(fields: Record<string, string>, token: string) {
    const check = Object.entries(fields).map(([a, b]) => `${a}=${b}`).sort().join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
  }
  const fields = { auth_date: '1000', user: JSON.stringify({ id: 7, first_name: 'Иван' }), start_param: 'abc' };

  it('принимает верную подпись и отвергает чужую и устаревшую', () => {
    expect(verifyInitData(sign(fields, 'bot'), 'bot', 1100)).toMatchObject({ id: 7, name: 'Иван', startParam: 'abc' });
    expect(verifyInitData(sign(fields, 'other'), 'bot', 1100)).toBeNull();
    expect(verifyInitData(sign(fields, 'bot'), 'bot', 1000 + 90_000)).toBeNull();
  });

  it('без подписи API не пускает, а заголовок разработчика работает только в режиме разработки', async () => {
    const app = buildApp({ db: openDb(':memory:'), botToken: 'bot', suggestFunds: async () => new Map() });
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-dev-user': '1' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('подсказки по выписке', () => {
  const row = (over: Partial<StatementRow>): StatementRow => ({
    hash: String(Math.random()), bank: 'freedom', account: '1111', date: '2026-10-10', amount: -100, currency: 'KZT', op: 'Покупка', details: 'SHOP', pending: false, ...over,
  });

  it('узнаёт переводы между банками, отмены покупок, возвраты и выплаты участнику', () => {
    const transferOut = row({ op: 'Перевод', details: 'Перевод с карты на карту. Комиссия: 0 тг.', amount: -5000 });
    const transferIn = row({ bank: 'kaspi', account: '2222', op: 'Пополнение', details: 'С карты другого банка', amount: 5000 });
    const buy = row({ details: 'OZON ALMATY KZ', amount: -6299 });
    const cancel = row({ details: 'Возврат. Отмена покупки OZON', amount: 6299 });
    const refund = row({ details: 'Возврат. Отмена покупки AZS RP67', amount: 370 });
    const toMember = row({ bank: 'kaspi', account: '2222', op: 'Перевод', details: 'Анна Г.', amount: -1000 });
    const own = row({ op: 'Перевод', details: 'Между своими счетами', amount: -700 });
    const salary = row({ op: 'Пополнение', details: 'ТОО РАБОТА', amount: 90000 });
    const usd = row({ currency: 'USD', details: 'Возврат. Отмена покупки aliexpress', amount: 1066 });

    const result = suggestActions([transferOut, transferIn, buy, cancel, refund, toMember, own, salary, usd], [{ userId: 2, name: 'Анна' }]);
    const action = (r: StatementRow) => result.get(r.hash)!.action;
    expect([action(transferOut), action(transferIn), action(buy), action(cancel), action(own)]).toEqual(Array(5).fill('skip'));
    // Возврат в валюте идёт в учёт по курсу
    expect(action(usd)).toBe('expense');
    expect(action(refund)).toBe('expense');
    expect(action(toMember)).toBe('settlement');
    expect(result.get(toMember.hash)!.userId).toBe(2);
    expect(action(salary)).toBe('income');
  });

  it('узнаёт участника с эмодзи в имени, а имя из одних эмодзи ни с чем не совпадает', () => {
    const toMember = row({ bank: 'kaspi', account: '2222', op: 'Перевод', details: 'Анна Г.', amount: -1000 });
    const result = suggestActions([toMember], [{ userId: 7, name: '🐭' }, { userId: 3, name: '🤡 Анна' }]);
    expect(result.get(toMember.hash)).toMatchObject({ action: 'settlement', userId: 3 });
  });

  it('считает один и тот же магазин одним продавцом', () => {
    expect(merchantKey('IP COFFEE DAVAI QONAEV KZ')).toBe('IP COFFEE DAVAI');
    expect(merchantKey('Возврат. Отмена покупки OZON')).toBe(merchantKey('OZON ALMATY KZ'));
  });
});

// Настоящие выписки в репозитории не лежат. Путь передаётся через переменные окружения
const kaspiPath = process.env.KASPI_PDF;
const freedomPath = process.env.FREEDOM_PDF;

describe.skipIf(!kaspiPath || !existsSync(kaspiPath))('настоящая выписка Kaspi', () => {
  it('сходится с итогами банка', async () => {
    const parsed = await parseStatement(new Uint8Array(readFileSync(kaspiPath!)));
    expect(parsed.bank).toBe('kaspi');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.rows.length).toBe(24);
  });
});

describe.skipIf(!freedomPath || !existsSync(freedomPath))('настоящая выписка Freedom', () => {
  it('сходится с итогами банка и помечает операции в обработке', async () => {
    const parsed = await parseStatement(new Uint8Array(readFileSync(freedomPath!)));
    expect(parsed.bank).toBe('freedom');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.pendingCount).toBe(5);
    expect(parsed.rows.length).toBe(72);
    expect(parsed.rows.filter((r) => r.pending).length).toBe(5);
  });
});

describe.skipIf(!kaspiPath || !freedomPath)('импорт двух выписок через API', () => {
  it('разбирает, не показывает повторы и записывает только подтверждённое', async () => {
    const { call, app } = setup();
    const { base, fund } = await ledger(call);
    const upload = async () => {
      const boundary = 'x-boundary';
      const parts: Buffer[] = [];
      for (const [name, path] of [['k.pdf', kaspiPath!], ['f.pdf', freedomPath!]]) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`), readFileSync(path), Buffer.from('\r\n'));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const res = await app.inject({ method: 'POST', url: `${base}/imports`, headers: { 'x-dev-user': '1', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) });
      expect(res.statusCode).toBe(200);
      return res.json().id as number;
    };
    const id = await upload();
    const batch = (await call(1, 'GET', `${base}/imports/${id}`)).body;
    expect(batch.rows.length).toBe(96);
    expect(batch.warnings.filter((w: string) => w.includes('итогах'))).toEqual([]);

    const buy = batch.rows.find((r: any) => r.amount < 0 && r.suggestedAction === 'expense' && r.currency === 'KZT' && r.op === 'Покупка');
    const half = Math.floor(-buy.amount / 2);
    const decided = await call(1, 'POST', `${base}/imports/${id}/decide`, {
      decisions: [
        { rowId: buy.id, action: 'expense', parts: [{ fundId: fund('Еда'), amount: half }, { fundId: fund('Дом'), amount: -buy.amount - half }] },
        { rowId: batch.rows.find((r: any) => r.suggestedAction === 'skip').id, action: 'skip' },
      ],
    });
    expect(decided.body).toEqual({ posted: 1, skipped: 1 });
    const { report } = (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body;
    expect(report.spentTotal).toBe(-buy.amount);

    const second = (await call(1, 'GET', `${base}/imports/${await upload()}`)).body;
    expect(second.rows.length).toBe(0);
    expect(second.warnings.join(' ')).toContain('Уже были');
  });
});

describe('выписки через бота', () => {
  const statement = (account: string, dates: string[]) => ({
    bank: 'kaspi' as const,
    account,
    pendingCount: 0,
    warnings: [],
    rows: dates.map((date, i): StatementRow => ({ hash: `${account}-${i}`, bank: 'kaspi', account, date, amount: -k(100 + i), currency: 'KZT', op: 'Покупка', details: 'SHOP', pending: false })),
  });
  function bot(parsed: ReturnType<typeof statement>) {
    const sent: { chat: number; text: string; keyboard?: any }[] = [];
    const edited: string[] = [];
    const io: BotIo = {
      send: async (chat, text, keyboard) => void sent.push({ chat, text, keyboard }),
      edit: async (_chat, _id, text) => void edited.push(text),
      answer: async () => {},
      download: async () => new Uint8Array([1]),
      parse: async () => parsed,
    };
    return { io, sent, edited };
  }
  const pdf = (user: number, id = 1): TgUpdate => ({
    update_id: id,
    message: { message_id: id, chat: { id: user, type: 'private' }, from: { id: user }, document: { file_id: 'f', file_name: 'gold.pdf', mime_type: 'application/pdf', file_size: 1000 } },
  });

  it('одна база: выписка сразу в очереди, обработка создаёт выписку на проверку', async () => {
    const { db, call } = setup();
    const { base } = await ledger(call);
    const { io, sent } = bot(statement('1234', ['2026-10-03', '2026-10-01', '2026-10-20']));
    await handleUpdate(db, io, pdf(1));
    expect(sent[0].text).toBe('Выписка Kaspi Gold по карте *1234 за 01.10.2026–20.10.2026 отправлена в очередь в приложении, база «Семья». Чтобы разнести операции по фондам, открой приложение и нажми «Обработать».');

    const queue = (await call(1, 'GET', `${base}/queue`)).body;
    expect(queue).toMatchObject([{ bank: 'kaspi', account: '1234', dateFrom: '2026-10-01', dateTo: '2026-10-20', count: 3 }]);
    const { id } = (await call(1, 'POST', `${base}/queue/process`)).body;
    expect((await call(1, 'GET', `${base}/imports/${id}`)).body.rows).toHaveLength(3);
    expect((await call(1, 'GET', `${base}/queue`)).body).toEqual([]);
    expect((await call(1, 'POST', `${base}/queue/process`)).status).toBe(400);
  });

  it('несколько баз: бот спрашивает, в какую; чужой человек и заблокированная база не проходят', async () => {
    const { db, call } = setup();
    const first = await ledger(call);
    const second = (await call(1, 'POST', '/api/ledgers', { name: 'Тест', startYm: '2026-10' })).body.id;
    const { io, sent, edited } = bot(statement('5678', ['2026-10-05']));
    await handleUpdate(db, io, pdf(1));
    expect(sent[0].text).toBe('Выписка Kaspi Gold по карте *5678 за 05.10.2026 прочитана. В какую базу её отправить?');
    const buttons = sent[0].keyboard.inline_keyboard.flat();
    expect(buttons.map((b: any) => b.text)).toEqual(['Семья', 'Тест']);
    expect((await call(1, 'GET', `${first.base}/queue`)).body).toEqual([]);

    const choose = (user: number, data: string): TgUpdate => ({ update_id: 9, callback_query: { id: 'c', from: { id: user }, data, message: { message_id: 1, chat: { id: user, type: 'private' } } } });
    await handleUpdate(db, io, choose(2, buttons[1].callback_data));
    expect(edited).toEqual([]);
    await handleUpdate(db, io, choose(1, buttons[1].callback_data));
    expect(edited[0]).toMatch(/отправлена в очередь в приложении, база «Тест»/);
    expect((await call(1, 'GET', `/api/ledgers/${second}/queue`)).body).toHaveLength(1);
    // Повторное нажатие ничего не меняет
    await handleUpdate(db, io, choose(1, buttons[0].callback_data));
    expect((await call(1, 'GET', `${first.base}/queue`)).body).toEqual([]);

    await call(1, 'PATCH', `/api/ledgers/${second}`, { locked: true });
    await handleUpdate(db, io, pdf(1, 2));
    expect(sent.at(-1)!.text).toMatch(/отправлена в очередь в приложении, база «Семья»/);
    await handleUpdate(db, io, pdf(3, 3));
    expect(sent.at(-1)!.text).toMatch(/не участник ни одной базы/);
  });

  it('участник видит и убирает только свои выписки', async () => {
    const { db, call } = setup();
    const { base } = await ledger(call);
    const invite = (await call(1, 'POST', `${base}/invites`)).body;
    await call(2, 'POST', '/api/invites/accept', { token: invite.token });
    const { io } = bot(statement('1111', ['2026-10-05']));
    await handleUpdate(db, io, pdf(1));
    await handleUpdate(db, io, pdf(2, 2));
    const all = (await call(1, 'GET', `${base}/queue`)).body;
    expect(all).toHaveLength(2);
    expect((await call(2, 'GET', `${base}/queue`)).body).toHaveLength(1);
    expect((await call(2, 'DELETE', `${base}/queue/${all[0].id}`)).status).toBe(403);
    expect((await call(2, 'DELETE', `${base}/queue/${all[1].id}`)).status).toBe(200);
    expect((await call(1, 'GET', `${base}/queue`)).body).toHaveLength(1);
  });
});

describe('доходы по категориям', () => {
  it('зарплата по людям из тегов «зп …», остальное по самому частому тегу', async () => {
    const { call } = setup();
    const { base } = await ledger(call);
    const income = (date: string, amount: number, tags: string[], earnedBy?: number) => call(1, 'POST', `${base}/entries`, { date, kind: 'income', amount: k(amount), tags, earnedBy });
    await income('2026-10-01', 500, ['зп основная'], 1);
    await income('2026-10-15', 100, ['зп райд', 'отпускные'], 1);
    await income('2026-10-20', 30, ['кешбек']);
    await income('2026-11-01', 20, ['кешбек', 'подарки']);
    await income('2026-11-02', 5, []);
    const rows = (await call(1, 'GET', `${base}/incomes/categories`)).body;
    expect(rows).toEqual(
      expect.arrayContaining([
        { ym: '2026-10', category: 'ЗП Тест 1', total: k(600) },
        { ym: '2026-10', category: 'Кешбек', total: k(30) },
        { ym: '2026-11', category: 'Кешбек', total: k(20) },
        { ym: '2026-11', category: 'Без тега', total: k(5) },
      ]),
    );
    expect(rows).toHaveLength(4);
  });
});

describe('проверка выписки', () => {
  it('возврат объединяется с покупкой в один расход, доход получает теги', async () => {
    const { db, call } = setup();
    const { base, fund } = await ledger(call);
    const ledgerId = Number(base.split('/').at(-1));
    const row = (hash: string, amount: number, details: string, op = 'Покупка'): StatementRow => ({ hash, bank: 'freedom', account: '1', date: '2026-10-10', amount, currency: 'KZT', op, details, pending: false });
    const batch = await createImportFromRows(db, async () => new Map(), ledgerId, 1, ['a.pdf'], [row('w', -k(45_399), 'Wolt Helsinki FI'), row('r', k(1_980), 'Возврат. Отмена покупки'), row('i', k(486_700), 'Перевод с карты на карту', 'Пополнение')], []);
    const rows = (await call(1, 'GET', `${base}/imports/${batch}`)).body.rows as { id: number; details: string }[];
    const id = (details: string) => rows.find((r) => r.details === details)!.id;

    // Объединять можно только с расходом в той же пачке решений
    expect((await call(1, 'POST', `${base}/imports/${batch}/decide`, { decisions: [{ rowId: id('Возврат. Отмена покупки'), action: 'merge', intoRowId: id('Wolt Helsinki FI') }] })).status).toBe(400);
    const res = await call(1, 'POST', `${base}/imports/${batch}/decide`, {
      decisions: [
        { rowId: id('Wolt Helsinki FI'), action: 'expense', tags: ['доставка'], parts: [{ fundId: fund('Еда'), amount: k(43_419) }] },
        { rowId: id('Возврат. Отмена покупки'), action: 'merge', intoRowId: id('Wolt Helsinki FI') },
        { rowId: id('Перевод с карты на карту'), action: 'income', earnedBy: 1, tags: ['зп основная'] },
      ],
    });
    expect(res.body).toEqual({ posted: 2, merged: 1, skipped: 0 });
    const entries = (await call(1, 'GET', `${base}/entries?ym=2026-10`)).body;
    expect(entries.map((e: any) => [e.kind, e.amount, e.tags])).toEqual(expect.arrayContaining([['expense', k(43_419), ['доставка']], ['income', k(486_700), ['зп основная']]]));
    expect(entries).toHaveLength(2);
    expect((await call(1, 'GET', `${base}/imports`)).body).toEqual([]);
  });
  it('черновик сохраняется, выписка отправляется целиком, отправку можно вернуть в черновик', async () => {
    const { db, call } = setup();
    const { base, fund } = await ledger(call);
    const ledgerId = Number(base.split('/').at(-1));
    const row = (hash: string, amount: number, details: string, op = 'Покупка'): StatementRow => ({ hash, bank: 'freedom', account: '1', date: '2026-10-10', amount, currency: 'KZT', op, details, pending: false });
    const batch = await createImportFromRows(db, async () => new Map(), ledgerId, 1, ['a.pdf'], [row('w', -k(4_000), 'Wolt'), row('i', k(500_000), 'Перевод', 'Пополнение')], []);
    const rows = (await call(1, 'GET', `${base}/imports/${batch}`)).body.rows as { id: number; details: string }[];
    const id = (details: string) => rows.find((r) => r.details === details)!.id;

    expect((await call(1, 'PUT', `${base}/imports/${batch}/draft`, { draft: { [id('Wolt')]: { action: 'expense', comment: 'обед' } } })).status).toBe(200);
    expect((await call(1, 'GET', `${base}/imports/${batch}`)).body.draft).toEqual({ [id('Wolt')]: { action: 'expense', comment: 'обед' } });

    // Половину отправить нельзя
    expect((await call(1, 'POST', `${base}/imports/${batch}/decide`, { decisions: [{ rowId: id('Wolt'), action: 'skip' }] })).status).toBe(400);
    const wolt = { rowId: id('Wolt'), action: 'expense', parts: [{ fundId: fund('Еда'), amount: k(4_000) }] };
    expect((await call(1, 'POST', `${base}/imports/${batch}/decide`, { decisions: [wolt, { rowId: id('Перевод'), action: 'income', earnedBy: 1, tags: ['зп тест'] }] })).status).toBe(200);
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body).toHaveLength(2);
    expect((await call(1, 'GET', `${base}/imports/sent`)).body).toMatchObject([{ id: batch, posted: 2, pending: 0 }]);

    // Категория дохода для выбора берётся из уже внесённых доходов
    expect((await call(1, 'GET', `${base}/incomes/category-options`)).body).toEqual([{ category: 'ЗП Тест 1', tag: 'зп тест', earnedBy: 1, count: 1 }]);

    // Отмена снимает операции, строки снова ждут проверки, черновик на месте
    expect((await call(1, 'POST', `${base}/imports/${batch}/revert`, {})).body).toEqual({ entries: 2, settlements: 0, rows: 2 });
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body).toHaveLength(0);
    const back = (await call(1, 'GET', `${base}/imports/${batch}`)).body;
    expect(back.rows).toHaveLength(2);
    expect(back.draft[id('Wolt')]).toMatchObject({ comment: 'обед' });
    expect((await call(1, 'GET', `${base}/imports/sent`)).body).toEqual([]);

    // В закрытом месяце отмена спрашивает согласие на пересчёт и пишется в журнал
    await call(1, 'POST', `${base}/imports/${batch}/decide`, { decisions: [wolt, { rowId: id('Перевод'), action: 'skip' }] });
    await call(1, 'POST', `${base}/months/2026-10/close`);
    expect((await call(1, 'POST', `${base}/imports/${batch}/revert`, {})).status).toBe(409);
    expect((await call(1, 'POST', `${base}/imports/${batch}/revert`, { recalc: true })).status).toBe(200);
    expect((await call(1, 'GET', `${base}/changes`)).body).toMatchObject([{ kind: 'entry', action: 'delete' }]);

    // Пачка из сверки блокнота не показывается в отправленных и не отменяется
    db.prepare(`UPDATE import_rows SET decision = 'posted' WHERE batch_id = ?`).run(batch);
    expect((await call(1, 'GET', `${base}/imports/sent`)).body).toHaveLength(1);
    db.prepare('UPDATE import_batches SET locked = 1 WHERE id = ?').run(batch);
    expect((await call(1, 'GET', `${base}/imports/sent`)).body).toEqual([]);
    expect((await call(1, 'POST', `${base}/imports/${batch}/revert`, { recalc: true })).status).toBe(400);
  });
});

describe('стартовые свободные', () => {
  it('старое поле ledgers.opening_free переносится в корректировку первого месяца и удаляется', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'monzoid-'));
    try {
      const path = join(dir, 'old.db');
      const old = openDb(path);
      old.exec('ALTER TABLE ledgers ADD COLUMN opening_free INTEGER NOT NULL DEFAULT 0');
      old.exec(`INSERT INTO users (id, name) VALUES (1, 'И')`);
      old.exec(`INSERT INTO ledgers (name, start_ym, opening_free, created_by) VALUES ('Старая', '2025-05', 1234500, 1), ('Пустая', '2025-05', 0, 1)`);
      old.close();
      const db = openDb(path);
      expect(db.prepare('PRAGMA table_info(ledgers)').all().some((c: any) => c.name === 'opening_free')).toBe(false);
      expect(db.prepare('SELECT ledger_id, date, amount, comment FROM adjustments').all()).toEqual([
        { ledger_id: 1, date: '2025-05-01', amount: 1234500, comment: 'Свободные средства на начало учёта' },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('эмодзи фондов', () => {
  it('подбирается по названию, меняется, стирается и выключается в оформлении', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const funds = () => call(1, 'GET', `${base}/funds`).then((r) => r.body as { id: number; name: string; emoji: string }[]);
    expect((await funds()).find((f) => f.name === 'Еда')!.emoji).toBe('🛒');
    await call(1, 'POST', `${base}/funds`, { name: 'Кошка' });
    expect((await funds()).find((f) => f.name === 'Кошка')!.emoji).toBe('');
    await call(1, 'PATCH', `${base}/funds/${fund('Еда')}`, { emoji: '🍎' });
    let me = (await call(1, 'GET', '/api/me')).body;
    expect(me.user.fundEmoji).toBe(true);
    expect(me.ledgers[0].fundEmojis['Еда']).toBe('🍎');
    await call(1, 'PATCH', `${base}/funds/${fund('Еда')}`, { emoji: '' });
    me = (await call(1, 'GET', '/api/me')).body;
    expect(me.ledgers[0].fundEmojis['Еда']).toBeUndefined();
    await call(1, 'PATCH', '/api/me', { fundEmoji: false, memberEmoji: false });
    expect((await call(1, 'GET', '/api/me')).body.user).toMatchObject({ fundEmoji: false, memberEmoji: false });

    // Эмодзи участника получает его личный фонд
    const { body: f } = await call(1, 'POST', `${base}/funds`, { name: 'Личные: Тест' });
    await call(1, 'PATCH', `${base}/funds/${f.id}`, { ownerUserId: 1 });
    const self = (await call(1, 'GET', `${base}/members`)).body[0];
    await call(1, 'PATCH', `${base}/members/${self.userId}`, { name: 'Тест', emoji: '🐻' });
    me = (await call(1, 'GET', '/api/me')).body;
    expect(me.ledgers[0].memberEmojis['Тест']).toBe('🐻');
    expect(me.ledgers[0].fundEmojis['Личные: Тест']).toBe('🐻');
    expect(f.id).toBeGreaterThan(0);
  });

  it('эмодзи в начале имени участника переезжает в отдельное поле', async () => {
    const { splitLeadingEmoji } = await import('../src/emoji.js');
    expect(splitLeadingEmoji('🐻Иван')).toEqual(['🐻', 'Иван']);
    expect(splitLeadingEmoji('❤️‍🔥 Аня')).toEqual(['❤️‍🔥', 'Аня']);
    expect(splitLeadingEmoji('Иван')).toEqual(['', 'Иван']);
    expect(splitLeadingEmoji('🐻')).toEqual(['', '🐻']);
  });
});

describe('личный фонд участника', () => {
  it('один на участника, начисления только в личный фонд и снимаются при смене', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const funds = () => call(1, 'GET', `${base}/funds`).then((r) => r.body as { id: number; ownerUserId: number | null; creditUserId: number | null }[]);
    const a = (await call(1, 'POST', `${base}/funds`, { name: 'Мои' })).body.id;
    const b = (await call(1, 'POST', `${base}/funds`, { name: 'Мои 2' })).body.id;
    await call(1, 'PATCH', `${base}/funds/${a}`, { ownerUserId: 1 });
    await call(1, 'PATCH', `${base}/funds/${a}`, { creditUserId: 1 });
    expect((await funds()).find((f) => f.id === a)).toMatchObject({ ownerUserId: 1, creditUserId: 1 });
    // Другой личный фонд: прежний перестаёт быть личным, начисление с него снимается
    await call(1, 'PATCH', `${base}/funds/${b}`, { ownerUserId: 1 });
    expect((await funds()).find((f) => f.id === a)).toMatchObject({ ownerUserId: null, creditUserId: null });
    expect((await funds()).find((f) => f.id === b)).toMatchObject({ ownerUserId: 1, creditUserId: null });
    // Чужой личный фонд не получает начисления другому участнику
    const v = (await call(1, 'POST', `${base}/members/virtual`, { name: 'Аня' })).body.userId;
    expect((await call(1, 'PATCH', `${base}/funds/${b}`, { creditUserId: v })).status).toBe(400);
    // Начисление в ничейный фонд делает его личным
    await call(1, 'PATCH', `${base}/funds/${fund('Еда')}`, { creditUserId: v });
    expect((await funds()).find((f) => f.id === fund('Еда'))).toMatchObject({ ownerUserId: v, creditUserId: v });
  });
});

describe('сопутствующие расходы актива', () => {
  it('расход привязывается к активу, не меняет его стоимость и сохраняется при правке без поля', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const flat = (await call(1, 'POST', `${base}/pots`, { name: 'Квартира', kind: 'asset', openingBalance: k(30000) })).body.id;
    const fee = { date: '2026-10-05', kind: 'expense', amount: k(500), fundId: fund('Дом'), comment: 'агентские', potId: flat };
    const { body } = await call(1, 'POST', `${base}/entries`, fee);
    expect((await call(1, 'GET', `${base}/pots/${flat}/expenses`)).body).toMatchObject([{ id: body.id, amount: k(500), comment: 'агентские', fundName: 'Дом' }]);
    // Правка без potId привязку не снимает, null снимает
    await call(1, 'PUT', `${base}/entries/${body.id}`, { ...fee, potId: undefined, comment: 'агентские за квартиру' });
    expect((await call(1, 'GET', `${base}/pots/${flat}/expenses`)).body).toHaveLength(1);
    const pot = (await call(1, 'GET', `${base}/pots`)).body.find((p: any) => p.id === flat);
    expect(pot.value).toBe(k(30000));
    await call(1, 'PUT', `${base}/entries/${body.id}`, { ...fee, potId: null });
    expect((await call(1, 'GET', `${base}/pots/${flat}/expenses`)).body).toEqual([]);
    // Не актив привязать нельзя
    const usd = (await call(1, 'POST', `${base}/pots`, { name: 'Доллары', kind: 'currency', currency: 'USD', openingBalance: k(100), openingUnits: 1 })).body.id;
    expect((await call(1, 'POST', `${base}/entries`, { ...fee, potId: usd })).status).toBe(404);
  });
});

describe('расход по активу без фонда', () => {
  it('списывается из свободных, не трогает фонды и стоимость актива', async () => {
    const { call } = setup();
    const { base } = await ledger(call);
    const flat = (await call(1, 'POST', `${base}/pots`, { name: 'Квартира', kind: 'asset', openingBalance: k(30000) })).body.id;
    const before = (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body.report;
    expect((await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(500), comment: 'агентские' })).status).toBe(400);
    const { status } = await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(500), fundId: null, potId: flat, comment: 'агентские' });
    expect(status).toBe(200);
    const after = (await call(1, 'GET', `${base}/summary?ym=2026-10`)).body.report;
    expect(after.assetCosts).toBe(k(500));
    expect(after.freeAfter).toBe(before.freeAfter - k(500));
    expect(after.fundsAfter).toBe(before.fundsAfter);
    expect(after.spentTotal).toBe(before.spentTotal);
    expect(after.assetsAfter).toBe(before.assetsAfter);
    expect((await call(1, 'GET', `${base}/pots/${flat}/expenses`)).body).toMatchObject([{ amount: k(500), fundName: null }]);
  });
});

describe('правка операции закрытого месяца', () => {
  it('комментарий и описание меняются без согласия на пересчёт, сумма и теги только с ним', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const body = { date: '2026-10-05', kind: 'expense', amount: k(100), fundId: fund('Еда'), comment: 'рынок', tags: ['овощи'] };
    const id = (await call(1, 'POST', `${base}/entries`, body)).body.id;
    await call(1, 'POST', `${base}/months/2026-10/close`);

    expect((await call(1, 'PUT', `${base}/entries/${id}`, { ...body, comment: 'зелёный базар', description: 'MAGNUM' })).status).toBe(200);
    // Теги в другом регистре это те же теги
    expect((await call(1, 'PUT', `${base}/entries/${id}`, { ...body, comment: 'зелёный базар', description: 'MAGNUM', tags: ['Овощи'] })).status).toBe(200);
    expect((await call(1, 'PUT', `${base}/entries/${id}`, { ...body, amount: k(101) })).status).toBe(409);
    expect((await call(1, 'PUT', `${base}/entries/${id}`, { ...body, tags: ['фрукты'] })).status).toBe(409);
    expect((await call(1, 'PUT', `${base}/entries/${id}`, { ...body, date: '2026-11-01' })).status).toBe(409);
    expect((await call(1, 'PUT', `${base}/entries/${id}`, { ...body, fundId: fund('Кафе') })).status).toBe(409);
    expect((await call(1, 'PUT', `${base}/entries/${id}`, { ...body, paidBy: 1 })).status).toBe(409);

    const entry = (await call(1, 'GET', `${base}/entries?ym=2026-10`)).body[0];
    expect(entry).toMatchObject({ comment: 'зелёный базар', description: 'MAGNUM', amount: k(100) });
    // Правка закрытого месяца всё равно попадает в журнал, её можно откатить; правка без изменений не пишется
    const changes = (await call(1, 'GET', `${base}/changes`)).body;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ action: 'update', before: { comment: 'рынок' }, after: { comment: 'зелёный базар' } });
    expect((await call(1, 'POST', `${base}/changes/${changes[0].id}/revert`)).status).toBe(200);
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body[0].comment).toBe('рынок');
  });
});

describe('возврат с привязкой', () => {
  it('возврат гасит покупку частично и полностью, больше покупки вернуть нельзя', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const buy = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(1_000), fundId: fund('Одежда'), comment: 'куртка' })).body.id;
    const income = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-01', kind: 'income', amount: k(5_000) })).body.id;
    const refund = (amount: number, refundOf: number | null, date = '2026-10-10') => call(1, 'POST', `${base}/entries`, { date, kind: 'expense', amount: -k(amount), fundId: fund('Одежда'), comment: 'возврат', refundOf });
    const list = async () => (await call(1, 'GET', `${base}/entries?from=2026-10&to=2026-11`)).body as any[];

    expect((await call(1, 'GET', `${base}/entries/refundable?fundId=${fund('Одежда')}`)).body.map((e: any) => e.id)).toEqual([buy]);
    expect((await call(1, 'GET', `${base}/entries/refundable?fundId=${fund('Еда')}`)).body).toEqual([]);
    expect((await call(1, 'GET', `${base}/entries/refundable?q=${encodeURIComponent('куртка')}`)).body).toHaveLength(1);

    const first = (await refund(400, buy)).body.id;
    let rows = await list();
    expect(rows.find((e) => e.id === buy)).toMatchObject({ refunded: k(400), refundOf: null });
    expect(rows.find((e) => e.id === first)).toMatchObject({ refundOf: { id: buy, date: '2026-10-05', amount: k(1_000), note: 'куртка' }, refunded: 0 });

    expect((await refund(700, buy)).status).toBe(400);
    expect((await refund(100, income)).status).toBe(404);
    expect((await call(1, 'POST', `${base}/entries`, { date: '2026-10-10', kind: 'expense', amount: k(100), fundId: fund('Одежда'), refundOf: buy })).status).toBe(400);
    // Возврат в следующем месяце тоже гасит покупку
    const second = (await refund(600, buy, '2026-11-02')).body.id;
    rows = await list();
    expect(rows.find((e) => e.id === buy).refunded).toBe(k(1_000));
    expect((await call(1, 'GET', `${base}/entries/refundable`)).body).toEqual([]);
    expect((await call(1, 'GET', `${base}/entries/refundable?include=${buy}&except=${second}`)).body.map((e: any) => e.id)).toEqual([buy]);

    // Покупку нельзя сделать меньше возвращённого; правка суммы возврата проверяется так же
    expect((await call(1, 'PUT', `${base}/entries/${buy}`, { date: '2026-10-05', kind: 'expense', amount: k(900), fundId: fund('Одежда'), comment: 'куртка' })).status).toBe(400);
    expect((await call(1, 'PUT', `${base}/entries/${second}`, { date: '2026-11-02', kind: 'expense', amount: -k(700), fundId: fund('Одежда'), comment: 'возврат' })).status).toBe(400);
    // Без refundOf привязка остаётся, null её снимает
    expect((await call(1, 'PUT', `${base}/entries/${second}`, { date: '2026-11-02', kind: 'expense', amount: -k(500), fundId: fund('Одежда'), comment: 'возврат' })).status).toBe(200);
    expect((await list()).find((e) => e.id === buy).refunded).toBe(k(900));
    expect((await call(1, 'PUT', `${base}/entries/${second}`, { date: '2026-11-02', kind: 'expense', amount: -k(500), fundId: fund('Одежда'), comment: 'возврат', refundOf: null })).status).toBe(200);
    expect((await list()).find((e) => e.id === buy).refunded).toBe(k(400));
    // Удалённый возврат больше не гасит покупку
    await call(1, 'DELETE', `${base}/entries/${first}`);
    expect((await list()).find((e) => e.id === buy).refunded).toBe(0);
    // На итоги связь не влияет: возврат и так расход с минусом
    expect((await call(1, 'GET', `${base}/summary?ym=2026-11`)).body.report.spentTotal).toBe(-k(500));
  });

  it('привязка в закрытом месяце не требует пересчёта, пишется в журнал и откатывается', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const buy = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount: k(1_000), fundId: fund('Одежда') })).body.id;
    const body = { date: '2026-10-07', kind: 'expense', amount: -k(1_000), fundId: fund('Одежда'), comment: 'возврат' };
    const back = (await call(1, 'POST', `${base}/entries`, body)).body.id;
    await call(1, 'POST', `${base}/months/2026-10/close`);
    expect((await call(1, 'PUT', `${base}/entries/${back}`, { ...body, refundOf: buy })).status).toBe(200);
    const [change] = (await call(1, 'GET', `${base}/changes`)).body;
    expect(change.before.refundOf).toBeUndefined();
    expect(change.after.refundOf).toBe(buy);
    expect((await call(1, 'POST', `${base}/changes/${change.id}/revert`)).status).toBe(200);
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body.find((e: any) => e.id === buy).refunded).toBe(0);
  });

  it('при проверке выписки возврат привязывается к покупке', async () => {
    const { db, call } = setup();
    const { base, fund } = await ledger(call);
    const ledgerId = Number(base.split('/').at(-1));
    const buy = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-01', kind: 'expense', amount: k(2_000), fundId: fund('Одежда') })).body.id;
    const row = (hash: string, amount: number, details: string): StatementRow => ({ hash, bank: 'freedom', account: '1', date: '2026-10-10', amount, currency: 'KZT', op: 'Покупка', details, pending: false });
    const batch = await createImportFromRows(db, async () => new Map(), ledgerId, 1, ['a.pdf'], [row('r', k(1_500), 'Zara'), row('x', k(1_000), 'Zara 2')], []);
    const rows = (await call(1, 'GET', `${base}/imports/${batch}`)).body.rows as { id: number; details: string }[];
    const id = (details: string) => rows.find((r) => r.details === details)!.id;
    const decide = (second: number) => call(1, 'POST', `${base}/imports/${batch}/decide`, {
      decisions: [
        { rowId: id('Zara'), action: 'expense', parts: [{ fundId: fund('Одежда'), amount: k(1_500), refundOf: buy }] },
        { rowId: id('Zara 2'), action: 'expense', parts: [{ fundId: fund('Одежда'), amount: second, refundOf: second < k(1_000) ? buy : null }] },
      ],
    });
    // Вместе два возврата больше покупки: ничего не вносится
    const tooMuch = await call(1, 'POST', `${base}/imports/${batch}/decide`, {
      decisions: [
        { rowId: id('Zara'), action: 'expense', parts: [{ fundId: fund('Одежда'), amount: k(1_500), refundOf: buy }] },
        { rowId: id('Zara 2'), action: 'expense', parts: [{ fundId: fund('Одежда'), amount: k(1_000), refundOf: buy }] },
      ],
    });
    expect(tooMuch.status).toBe(400);
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body).toHaveLength(1);
    expect((await decide(k(1_000))).status).toBe(200);
    const entries = (await call(1, 'GET', `${base}/entries?ym=2026-10`)).body as any[];
    expect(entries.find((e) => e.id === buy).refunded).toBe(k(1_500));
    expect(entries.filter((e) => e.refundOf?.id === buy).map((e) => e.amount)).toEqual([-k(1_500)]);
  });
});

describe('массовая правка операций', () => {
  it('теги, фонд, комментарий и сумма меняются у всех отмеченных', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const add = async (amount: number, tags: string[]) => (await call(1, 'POST', `${base}/entries`, { date: '2026-10-05', kind: 'expense', amount, fundId: fund('Еда'), comment: 'было', tags })).body.id;
    const a = await add(k(100), ['старый', 'общий']);
    const b = await add(-k(50), ['общий']);
    const income = (await call(1, 'POST', `${base}/entries`, { date: '2026-10-01', kind: 'income', amount: k(1_000) })).body.id;
    const res = await call(1, 'POST', `${base}/entries/bulk`, { ids: [a, b, income], addTags: ['Новый'], removeTags: ['#общий'], fundId: fund('Кафе'), comment: 'стало', amount: k(70) });
    expect(res.body).toEqual({ changed: 3 });
    const rows = async () => (await call(1, 'GET', `${base}/entries?ym=2026-10`)).body as any[];
    const by = async (id: number) => (await rows()).find((e) => e.id === id);
    expect(await by(a)).toMatchObject({ amount: k(70), fundName: 'Кафе', comment: 'стало' });
    expect((await by(a)).tags.sort()).toEqual(['новый', 'старый']);
    // У возврата знак остаётся, у дохода фонда нет
    expect(await by(b)).toMatchObject({ amount: -k(70), fundName: 'Кафе', tags: ['новый'] });
    expect(await by(income)).toMatchObject({ amount: k(70), fundId: null, comment: 'стало' });
    expect((await call(1, 'GET', `${base}/changes`)).body).toEqual([]);

    expect((await call(1, 'POST', `${base}/entries/bulk`, { ids: [a] })).status).toBe(400);
    expect((await call(1, 'POST', `${base}/entries/bulk`, { ids: [a], fundId: 999_999 })).status).toBe(404);
    // Ошибка в одной операции не меняет остальные
    expect((await call(1, 'POST', `${base}/entries/bulk`, { ids: [a, 999_999], comment: 'нет' })).status).toBe(404);
    expect((await by(a)).comment).toBe('стало');
    expect((await call(1, 'POST', `${base}/entries/bulk`, { ids: [a, b], delete: true })).body).toEqual({ changed: 2 });
    expect((await rows()).map((e) => e.id)).toEqual([income]);
  });

  it('закрытые месяцы: одно согласие на всю пачку, каждая операция в журнале', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const add = async (date: string) => (await call(1, 'POST', `${base}/entries`, { date, kind: 'expense', amount: k(100), fundId: fund('Еда'), comment: 'x' })).body.id;
    const closed1 = await add('2026-10-05');
    const closed2 = await add('2026-10-06');
    const open = await add('2026-11-01');
    await call(1, 'POST', `${base}/months/2026-10/close`);
    const ids = [closed1, closed2, open];

    // Комментарий итоги не меняет: без вопроса, но в журнал
    expect((await call(1, 'POST', `${base}/entries/bulk`, { ids, comment: 'y' })).status).toBe(200);
    expect((await call(1, 'GET', `${base}/changes`)).body).toHaveLength(2);
    const blocked = await call(1, 'POST', `${base}/entries/bulk`, { ids, addTags: ['т'] });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('2026-10');
    expect((await call(1, 'GET', `${base}/entries?ym=2026-11`)).body[0].tags).toEqual([]);
    expect((await call(1, 'POST', `${base}/entries/bulk`, { ids, addTags: ['т'], recalc: true })).body).toEqual({ changed: 3 });
    expect((await call(1, 'POST', `${base}/entries/bulk`, { ids, delete: true })).status).toBe(409);
    expect((await call(1, 'POST', `${base}/entries/bulk`, { ids, delete: true, recalc: true })).status).toBe(200);
    const changes = (await call(1, 'GET', `${base}/changes`)).body as any[];
    expect(changes.map((c) => c.action)).toEqual(['delete', 'delete', 'update', 'update', 'update', 'update']);
    // Удаление откатывается по одной операции
    expect((await call(1, 'POST', `${base}/changes/${changes[0].id}/revert`)).status).toBe(200);
    expect((await call(1, 'GET', `${base}/entries?ym=2026-10`)).body).toHaveLength(1);
  });

  it('участник правит только свои операции, заблокированная база не правится', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    const invite = (await call(1, 'POST', `${base}/invites`)).body;
    await call(2, 'POST', '/api/invites/accept', { token: invite.token });
    const mine = (await call(2, 'POST', `${base}/entries`, { date: '2026-11-02', kind: 'expense', amount: k(10), fundId: fund('Еда') })).body.id;
    const admins = (await call(1, 'POST', `${base}/entries`, { date: '2026-11-02', kind: 'expense', amount: k(10), fundId: fund('Еда') })).body.id;
    expect((await call(2, 'POST', `${base}/entries/bulk`, { ids: [mine, admins], comment: 'моё' })).status).toBe(403);
    expect((await call(2, 'POST', `${base}/entries/bulk`, { ids: [mine], comment: 'моё' })).status).toBe(200);
    await call(1, 'PATCH', base, { locked: true });
    expect((await call(1, 'POST', `${base}/entries/bulk`, { ids: [admins], comment: 'нет' })).status).toBe(423);
  });
});

describe('подсказка тегов по истории', () => {
  const sample = (over: Partial<TagSample>): TagSample => ({ date: '2026-10-01', kind: 'expense', fundId: 1, amount: k(1_000), merchant: '', texts: [], tags: [], ...over });
  const today = '2026-11-01';

  it('продавец: тег, который стоит почти всегда, ставится сам, редкий только подсказывается', () => {
    const history = [
      sample({ merchant: 'MAGNUM', tags: ['продукты', 'магнум'] }),
      sample({ merchant: 'MAGNUM', tags: ['продукты'] }),
      sample({ merchant: 'MAGNUM', tags: ['продукты', 'гости'] }),
      sample({ merchant: 'SMALL', tags: ['продукты'] }),
    ];
    const res = predictTags(history, { kind: 'expense', merchant: 'MAGNUM', fundId: 1, today });
    expect(res.auto).toEqual(['продукты']);
    expect(res.hints.slice(0, 3)).toEqual(['продукты', 'гости', 'магнум']);
    // Одна покупка у продавца без того же текста: только подсказка
    expect(predictTags([history[3]], { kind: 'expense', merchant: 'SMALL', today }).auto).toEqual([]);
  });

  it('у маркетплейса теги зависят от фонда', () => {
    const history = [
      sample({ merchant: 'OZON', fundId: 1, tags: ['озон', 'техника'] }),
      sample({ merchant: 'OZON', fundId: 1, tags: ['озон', 'техника'] }),
      sample({ merchant: 'OZON', fundId: 2, tags: ['озон', 'одежда'] }),
      sample({ merchant: 'OZON', fundId: 2, tags: ['озон', 'одежда'] }),
      sample({ merchant: 'OZON', fundId: 2, tags: ['озон', 'одежда'] }),
    ];
    expect(predictTags(history, { kind: 'expense', merchant: 'OZON', fundId: 1, today }).auto).toEqual(['озон', 'техника']);
    expect(predictTags(history, { kind: 'expense', merchant: 'OZON', fundId: 2, today }).auto).toEqual(['одежда', 'озон']);
    // Фонд ещё не выбран: только общий для всех тег
    expect(predictTags(history, { kind: 'expense', merchant: 'OZON', today }).auto).toEqual(['озон']);
  });

  it('повторяющаяся сумма в фонде узнаётся и у разных продавцов', () => {
    const history = [1, 2, 3].map((i) => sample({ fundId: 9, amount: k(45_000), merchant: `KASPI ${'X'.repeat(i)}`, tags: ['садик'] }));
    expect(predictTags(history, { kind: 'expense', merchant: 'PAY', fundId: 9, amount: k(45_500), today }).auto).toEqual(['садик']);
    // Другая сумма: только подсказка частого тега фонда
    const other = predictTags(history, { kind: 'expense', merchant: 'PAY', fundId: 9, amount: k(10_000), today });
    expect(other.auto).toEqual([]);
    expect(other.hints).toEqual(['садик']);
  });

  it('свежие операции весят больше: снятый тег перестаёт ставиться сам', () => {
    const old = [1, 2, 3].map(() => sample({ date: '2025-06-01', merchant: 'YANDEX', tags: ['такси'] }));
    const fresh = [1, 2].map(() => sample({ date: '2026-10-20', merchant: 'YANDEX', tags: ['доставка'] }));
    const res = predictTags([...fresh, ...old], { kind: 'expense', merchant: 'YANDEX', fundId: 1, today });
    expect(res.auto).toEqual(['доставка']);
    expect(res.hints).toContain('такси');
  });

  it('ручная операция: сумма и фонд в запросе подсказки', async () => {
    const { call } = setup();
    const { base, fund } = await ledger(call);
    for (const [day, comment] of [['01', 'оплата'], ['02', 'перевод воспитателю'], ['03', 'за ноябрь']]) {
      await call(1, 'POST', `${base}/entries`, { date: `2026-10-${day}`, kind: 'expense', amount: k(45_000), fundId: fund('Садик'), comment, tags: ['садик'] });
    }
    const suggest = async (amount: number) => (await call(1, 'GET', `${base}/tags/suggest?fundId=${fund('Садик')}&text=${encodeURIComponent('kaspi')}&amount=${amount}`)).body;
    expect(await suggest(k(45_000))).toEqual({ auto: ['садик'], frequent: ['садик'] });
    expect(await suggest(k(5_000))).toEqual({ auto: [], frequent: ['садик'] });
  });
});

describe('копия базы в Telegram', () => {
  it('по умолчанию раз в неделю; владелец меняет интервал и шлёт вручную, остальным нельзя', async () => {
    const db = openDb(':memory:');
    const sent: { chatId: number; name: string; size: number }[] = [];
    const sendDocument = async (chatId: number, file: Buffer, name: string) => { sent.push({ chatId, name, size: file.length }); };
    const app = buildApp({ db, botToken: 'test', devAuth: true, ownerIds: [1], suggestFunds: async () => new Map(), sendDocument });
    const call = async (user: number, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => {
      const res = await app.inject({ method, url, headers: { 'x-dev-user': String(user) }, ...(body ? { payload: body as any } : {}) });
      return { status: res.statusCode, body: res.json() };
    };
    expect((await call(1, 'GET', '/api/backup')).body).toMatchObject({ enabled: true, days: 7, lastSentAt: null, canSend: true });
    expect((await call(2, 'GET', '/api/backup')).status).toBe(403);
    expect((await call(2, 'POST', '/api/backup/send')).status).toBe(403);
    expect((await call(1, 'PATCH', '/api/backup', { days: 5 })).status).toBe(400);
    expect((await call(1, 'PATCH', '/api/backup', { enabled: false, days: 14 })).body).toMatchObject({ enabled: false, days: 14 });

    const res = await call(1, 'POST', '/api/backup/send');
    expect(res.body).toMatchObject({ sent: 1, lastSentAt: expect.any(String) });
    expect(sent).toMatchObject([{ chatId: 1, name: expect.stringMatching(/^monzoid-\d{4}-\d{2}-\d{2}\.db\.gz$/) }]);
    expect(sent[0].size).toBeGreaterThan(0);
  });

  it('по расписанию: первая отправка через полный интервал, выключенная не отправляется', async () => {
    const { backupDue, updateBackupSettings } = await import('../src/backup.js');
    const db = openDb(':memory:');
    const t0 = new Date('2026-11-12T00:00:00Z');
    expect(backupDue(db, t0)).toBe(false);
    expect(backupDue(db, new Date('2026-11-18T00:00:00Z'))).toBe(false);
    expect(backupDue(db, new Date('2026-11-19T00:00:00Z'))).toBe(true);
    updateBackupSettings(db, { enabled: false });
    expect(backupDue(db, new Date('2026-12-30T00:00:00Z'))).toBe(false);
  });
});
