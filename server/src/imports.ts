import { all, get, run, tx, type Db } from './db.js';
import { noteEntries, noteSettlement } from './notify.js';
import { logChange, snapshot, touchesClosed } from './changes.js';
import { assertWritable, DomainError } from './domain.js';
import { convert, ensureRatesOn, rateOn, type MarketSource } from './market.js';
import type { AiSuggestion, FundSuggester } from './statements/ai.js';
import { isAiEligible, isRefund, merchantKey, suggestActions } from './statements/classify.js';
import { parseStatement, StatementError, type StatementRow } from './statements/parse.js';
import { listTags, normalizeTags, setEntryTags } from './tags.js';
import { loadTagHistory, predictTags } from './tagModel.js';
import { checkRefund } from './refunds.js';

// Ниже этой доли продавец считается «смешанным» (например, маркетплейс): подсказка только как догадка
const CONFIDENT_SHARE = 0.7;
const MAX_EXAMPLES = 60;
const PENDING_WINDOW_DAYS = 10;

/** «2026-11-03 20:17:07» → «03.11» */
const dayMonth = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

// Банк при проведении иногда дописывает или убирает хвост у продавца («… MOUNTAIN VIEW US»)
const sameMerchant = (a: string, b: string) => a === b || (!!a && !!b && (a.startsWith(b) || b.startsWith(a)));

export interface UploadedFile {
  name: string;
  data: Uint8Array;
}

interface History {
  merchant: string;
  fundId: number;
  fundName: string;
  count: number;
}

function loadHistory(db: Db, ledgerId: number): History[] {
  return all<History>(
    db,
    `SELECT r.merchant_key merchant, e.fund_id fundId, f.name fundName, COUNT(*) count
     FROM entries e JOIN import_rows r ON r.id = e.import_row_id JOIN funds f ON f.id = e.fund_id
     WHERE e.ledger_id = ? AND e.kind = 'expense' AND e.inactive_at IS NULL AND r.merchant_key != ''
     GROUP BY r.merchant_key, e.fund_id ORDER BY count DESC`,
    ledgerId,
  );
}

export async function createImport(db: Db, suggestFunds: FundSuggester, ledgerId: number, userId: number, files: UploadedFile[], market?: MarketSource) {
  const warnings: string[] = [];
  const rows: StatementRow[] = [];
  for (const file of files) {
    try {
      const parsed = await parseStatement(file.data);
      rows.push(...parsed.rows);
      warnings.push(...parsed.warnings.map((w) => `${file.name}: ${w}`));
    } catch (e) {
      if (e instanceof StatementError) throw new DomainError(`${file.name}: ${e.message}`);
      throw e;
    }
  }
  return createImportFromRows(db, suggestFunds, ledgerId, userId, files.map((f) => f.name), rows, warnings, market);
}

export async function createImportFromRows(
  db: Db,
  suggestFunds: FundSuggester,
  ledgerId: number,
  userId: number,
  fileNames: string[],
  rows: StatementRow[],
  warnings: string[],
  market?: MarketSource,
) {
  const known = new Set(all<{ hash: string }>(db, 'SELECT hash FROM import_rows WHERE ledger_id = ?', ledgerId).map((r) => r.hash));
  const unseen = rows.filter((r) => !known.has(r.hash));
  // Повторы тоже показываются, но сразу с «Пропустить»: решает человек
  const repeated = rows.filter((r) => known.has(r.hash));
  if (repeated.length) warnings.push(`Уже были в прошлых выписках: ${repeated.length}.`);
  const earlier = new Map(
    all<{ hash: string; created_at: string; decision: string }>(
      db,
      `SELECT r.hash, b.created_at, r.decision FROM import_rows r JOIN import_batches b ON b.id = r.batch_id WHERE r.ledger_id = ? ORDER BY r.id`,
      ledgerId,
    ).map((r) => [r.hash, r]),
  );
  const seenHint = (hash: string) => {
    const e = earlier.get(hash);
    if (!e) return 'Уже была в прошлой выписке';
    const state = e.decision === 'posted' ? 'учтена' : e.decision === 'skipped' ? 'пропущена' : 'ждёт проверки';
    return `Уже была в выписке от ${dayMonth(e.created_at)} (${state}). Если это другая операция, выбери фонд вместо пропуска`;
  };

  // Проведённая операция заменяет свою запись «в обработке», а не добавляется второй раз.
  // booked: сколько по записи «в обработке» уже внесено (с объединёнными возвратами), банк часто проводит именно эту сумму
  const openPending = all<{ id: number; bank: string; date: string; amount: number; currency: string; merchant_key: string; decision: string; booked: number | null }>(
    db,
    `SELECT r.id, r.bank, r.date, r.amount, r.currency, r.merchant_key, r.decision,
       (SELECT SUM(e.amount) FROM entries e WHERE e.import_row_id = r.id AND e.inactive_at IS NULL) booked
     FROM import_rows r WHERE r.ledger_id = ? AND r.is_pending = 1 ORDER BY r.date, r.id`,
    ledgerId,
  );
  const baseCurrency = get<{ currency: string }>(db, 'SELECT currency FROM ledgers WHERE id = ?', ledgerId)!.currency;
  // 2 цента доллара в валюте операции, в сотых долях; без курса просто 2 сотых
  const tolerances = new Map<string, number>();
  const tolerance = (currency: string) => {
    if (!tolerances.has(currency)) tolerances.set(currency, Math.max(2, convert(db, 2, 'USD', currency)?.amount ?? 2));
    return tolerances.get(currency)!;
  };
  const settled: { id: number; row: StatementRow; undecided: boolean; pendingDate: string }[] = [];
  // Похожая операция «в обработке» с другой суммой: не пропускается, но человек видит, с чем сверить
  const nearMiss = new Map<string, string>();
  const fresh = unseen.filter((row) => {
    if (row.pending) return true;
    const key = merchantKey(row.details);
    const near = (p: (typeof openPending)[number]) =>
      p.bank === row.bank &&
      p.currency === row.currency &&
      sameMerchant(p.merchant_key, key) &&
      Math.abs(Date.parse(p.date) - Date.parse(row.date)) <= PENDING_WINDOW_DAYS * 86_400_000;
    const tol = tolerance(row.currency);
    // Суммы сравниваются с допуском ±2 цента (в других валютах столько же по курсу): банк округляет по-разному
    const close = (a: number, b: number) => Math.abs(a - b) <= tol;
    const i = openPending.findIndex(
      (p) => near(p) && (close(p.amount, row.amount) || (row.currency === baseCurrency && p.booked !== null && close(-p.booked, row.amount))),
    );
    if (i < 0) {
      const similar = openPending.find(near);
      if (similar) {
        nearMiss.set(row.hash, `Похоже на операцию «в обработке» от ${dayMonth(similar.date)} на ${Math.abs(similar.amount) / 100} ${similar.currency}${similar.decision === 'pending' ? '' : ', она уже учтена'}: банк мог изменить сумму. Проверь, не дубль ли`);
      }
      return true;
    }
    settled.push({ id: openPending[i].id, row, undecided: openPending[i].decision === 'pending', pendingDate: openPending[i].date });
    openPending.splice(i, 1);
    return false;
  });
  if (settled.length) warnings.push(`Проведены банком и уже учтены как операции в обработке: ${settled.length}.`);
  const pendingCount = fresh.filter((r) => r.pending).length;
  if (pendingCount) {
    warnings.push(`Операций в обработке: ${pendingCount}. Банк ещё может изменить или отменить их. Отменённую операцию удали из списка операций.`);
  }

  const members = all<{ userId: number; name: string }>(db, 'SELECT user_id userId, display_name name FROM members WHERE ledger_id = ? AND inactive_at IS NULL', ledgerId);
  const base = get<{ currency: string }>(db, 'SELECT currency FROM ledgers WHERE id = ?', ledgerId)!.currency;
  const actions = suggestActions(fresh, members, base);
  if (market) {
    for (const date of new Set(fresh.filter((r) => r.currency !== base).map((r) => r.date))) await ensureRatesOn(db, market, date);
  }

  const history = loadHistory(db, ledgerId);
  const historyByMerchant = new Map<string, History[]>();
  for (const h of history) historyByMerchant.set(h.merchant, [...(historyByMerchant.get(h.merchant) ?? []), h]);

  // Теги по истории: тот же продавец, та же сумма в фонде (подробности в tagModel.ts)
  const tagHistory = loadTagHistory(db, ledgerId);
  const knowsTags = (m: string) => predictTags(tagHistory, { kind: 'expense', merchant: m }).auto.length > 0;

  // Продавец с известным фондом, но без тегов тоже идёт на подсказку: нужны только его теги
  const unknown = [
    ...new Set(
      fresh
        .filter((r) => actions.get(r.hash)?.action === 'expense' && isAiEligible(r) && !isRefund(r))
        .map((r) => merchantKey(r.details))
        .filter((m) => m && (!historyByMerchant.has(m) || !knowsTags(m))),
    ),
  ];
  const funds = all<{ id: number; name: string }>(db, 'SELECT id, name FROM funds WHERE ledger_id = ? AND archived = 0 ORDER BY sort, id', ledgerId);
  const seenExamples = new Set<string>();
  const examples = history
    .filter((h) => !seenExamples.has(h.merchant) && seenExamples.add(h.merchant))
    .slice(0, MAX_EXAMPLES)
    .map((h) => ({ merchant: h.merchant, fund: h.fundName }));
  const aiSuggestions = unknown.length ? await suggestFunds(unknown, funds, examples, listTags(db, ledgerId).map((t) => t.name)) : new Map<string, AiSuggestion>();
  const fundNames = new Set(funds.map((f) => f.name.toLowerCase()));

  return tx(db, () => {
    const batchId = Number(
      run(
        db,
        'INSERT INTO import_batches (ledger_id, user_id, files, warnings) VALUES (?, ?, ?, ?)',
        ledgerId,
        userId,
        JSON.stringify(fileNames),
        JSON.stringify(warnings),
      ).lastInsertRowid,
    );
    for (const { id, row, undecided } of settled) {
      run(db, 'UPDATE import_rows SET hash = ?, op = ?, is_pending = 0 WHERE id = ?', row.hash, row.op, id);
      if (undecided) run(db, 'UPDATE import_rows SET date = ? WHERE id = ?', row.date, id);
    }
    const skipRows = [
      ...repeated.map((row) => ({ row, hint: seenHint(row.hash) })),
      ...settled.map(({ row, pendingDate }) => ({ row, hint: `Банк провёл операцию «в обработке» от ${dayMonth(pendingDate)}, она уже есть. Если это другая операция, выбери фонд вместо пропуска` })),
    ];
    for (const { row, hint } of skipRows) {
      run(
        db,
        `INSERT INTO import_rows (batch_id, ledger_id, hash, bank, date, amount, currency, op, details, merchant_key,
           suggested_action, suggestion_source, hint, is_pending, suggested_tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'skip', 'none', ?, 0, '[]')`,
        // Хеш уникален в базе: повтор хранится под своим, а исходный остаётся признаком «уже было»
        batchId, ledgerId, `${row.hash}#${batchId}`, row.bank, row.date, row.amount, row.currency, row.op, row.details, merchantKey(row.details), hint,
      );
    }
    for (const row of fresh) {
      const key = merchantKey(row.details);
      const suggestion = actions.get(row.hash)!;
      let fundId: number | null = null;
      let source = 'none';
      let hint = nearMiss.get(row.hash) ?? suggestion.hint;
      let tags: string[] = [];
      if (suggestion.action === 'expense') {
        const ai = aiSuggestions.get(key);
        const past = historyByMerchant.get(key);
        if (past) {
          const total = past.reduce((s, h) => s + h.count, 0);
          fundId = past[0].fundId;
          source = 'history';
          if (past[0].count / total < CONFIDENT_SHARE) {
            hint = hint || `Здесь покупаешь разное: чаще всего «${past[0].fundName}»`;
          }
        } else if (ai?.fundId) {
          fundId = ai.fundId;
          source = 'ai';
        }
        const learned = predictTags(tagHistory, { kind: 'expense', merchant: key, text: row.details, fundId, amount: row.currency === base ? row.amount : null }).auto;
        tags = learned.length ? learned : normalizeTags(ai?.tags ?? []).filter((t) => !fundNames.has(t));
      }
      run(
        db,
        `INSERT INTO import_rows (batch_id, ledger_id, hash, bank, date, amount, currency, op, details, merchant_key,
           suggested_action, suggested_fund_id, suggested_user_id, suggestion_source, hint, is_pending, suggested_tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        batchId,
        ledgerId,
        row.hash,
        row.bank,
        row.date,
        row.amount,
        row.currency,
        row.op,
        row.details,
        key,
        suggestion.action,
        fundId,
        suggestion.userId ?? null,
        source,
        hint,
        row.pending ? 1 : 0,
        JSON.stringify(tags),
      );
    }
    return batchId;
  });
}

export function getImport(db: Db, ledgerId: number, batchId: number) {
  const batch = get<{ id: number; user_id: number; files: string; warnings: string; created_at: string; draft: string | null }>(
    db,
    'SELECT id, user_id, files, warnings, created_at, draft FROM import_batches WHERE id = ? AND ledger_id = ?',
    batchId,
    ledgerId,
  );
  if (!batch) throw new DomainError('Выписка не найдена', 404);
  const { start_ym: startYm, currency: baseCurrency } = get<{ start_ym: string; currency: string }>(db, 'SELECT start_ym, currency FROM ledgers WHERE id = ?', ledgerId)!;
  const tagHistory = loadTagHistory(db, ledgerId);
  const rows = all<{ suggestedTags: string; amount: number; currency: string; date: string; details: string; merchantKey: string; suggestedFundId: number | null }>(
    db,
    `SELECT id, bank, date, amount, currency, op, details, suggested_action suggestedAction, suggested_fund_id suggestedFundId,
       suggested_user_id suggestedUserId, suggestion_source suggestionSource, hint, suggested_tags suggestedTags, merchant_key merchantKey
     FROM import_rows WHERE batch_id = ? AND decision = 'pending' ORDER BY date DESC, id`,
    batchId,
  ).map(({ merchantKey: merchant, ...r }) => {
    // Сумма в основной валюте по курсу на дату операции, иначе по последнему: на экране проверки её можно поправить
    const onDate = rateOn(db, r.currency, baseCurrency, r.date);
    const converted = onDate !== null ? { amount: Math.round(r.amount * onDate), rate: onDate, date: r.date } : convert(db, r.amount, r.currency, baseCurrency);
    // Подсказки тегов считаются при каждом открытии: учитывают и то, что отмечено после загрузки выписки
    const tagHints = predictTags(tagHistory, { kind: r.amount > 0 && !isRefund(r) ? 'income' : 'expense', merchant, text: r.details, fundId: r.suggestedFundId, amount: converted?.amount ?? null }).hints;
    return { ...r, suggestedTags: JSON.parse(r.suggestedTags) as string[], tagHints, baseAmount: converted?.amount ?? null, rate: converted?.rate ?? null, rateDate: converted?.date ?? null };
  });
  const closedMonths = all<{ ym: string }>(db, 'SELECT ym FROM closed_months WHERE ledger_id = ?', ledgerId).map((m) => m.ym);
  return {
    id: batch.id,
    userId: batch.user_id,
    files: JSON.parse(batch.files),
    warnings: JSON.parse(batch.warnings),
    createdAt: batch.created_at,
    startYm,
    baseCurrency,
    closedMonths,
    rows,
    // Черновик решений по строкам, как его оставил человек; null, если ещё не трогали
    draft: batch.draft ? (JSON.parse(batch.draft) as Record<string, unknown>) : null,
  };
}

function batchOwner(db: Db, ledgerId: number, batchId: number, actor: { userId: number; isAdmin: boolean }) {
  const batch = get<{ user_id: number }>(db, 'SELECT user_id FROM import_batches WHERE id = ? AND ledger_id = ?', batchId, ledgerId);
  if (!batch) throw new DomainError('Выписка не найдена', 404);
  if (!actor.isAdmin && batch.user_id !== actor.userId) throw new DomainError('Это выписка другого участника', 403);
}

/** Черновик хранится как есть: на учёт он не влияет, пока выписку не отправили. */
export function saveDraft(db: Db, ledgerId: number, batchId: number, actor: { userId: number; isAdmin: boolean }, draft: unknown) {
  batchOwner(db, ledgerId, batchId, actor);
  const json = JSON.stringify(draft);
  if (json.length > 2_000_000) throw new DomainError('Черновик слишком большой.');
  run(db, 'UPDATE import_batches SET draft = ? WHERE id = ?', json, batchId);
}

/** Отправленные выписки: последние, где есть разобранные строки. */
export function listSentImports(db: Db, ledgerId: number, actor: { userId: number; isAdmin: boolean }) {
  return all<{ files: string }>(
    db,
    `SELECT b.id, b.files, b.user_id userId, COALESCE(b.sent_at, b.created_at) sentAt,
       SUM(r.decision = 'posted') posted, SUM(r.decision = 'skipped') skipped, SUM(r.decision = 'pending') pending
     FROM import_batches b JOIN import_rows r ON r.batch_id = b.id
     WHERE b.ledger_id = ? AND b.locked = 0 AND (? OR b.user_id = ?)
     GROUP BY b.id HAVING SUM(r.decision != 'pending') > 0 ORDER BY b.id DESC LIMIT 10`,
    ledgerId,
    actor.isAdmin ? 1 : 0,
    actor.userId,
  ).map((b) => ({ ...b, files: JSON.parse(b.files) as string[] }));
}

/**
 * Возвращает отправленную выписку в черновик: операции и выплаты из неё снимаются (inactive_at), строки снова ждут проверки.
 * Черновик решений остаётся, поэтому после отмены видно то же, что было отправлено.
 */
export function revertImport(db: Db, ledgerId: number, batchId: number, actor: { userId: number; isAdmin: boolean }, recalc = false) {
  batchOwner(db, ledgerId, batchId, actor);
  if (get(db, 'SELECT 1 x FROM import_batches WHERE id = ? AND locked = 1', batchId)) throw new DomainError('Это связи с выписками из сверки блокнота, их отправку не отменить.');
  const rowIds = all<{ id: number }>(db, `SELECT id FROM import_rows WHERE batch_id = ? AND decision != 'pending'`, batchId).map((r) => r.id);
  if (!rowIds.length) throw new DomainError('В этой выписке нечего отменять.');
  const marks = rowIds.map(() => '?').join(',');
  const entries = all<{ id: number; date: string; created_by: number }>(
    db,
    `SELECT id, date, created_by FROM entries WHERE ledger_id = ? AND inactive_at IS NULL AND import_row_id IN (${marks})`,
    ledgerId,
    ...rowIds,
  );
  const settlements = all<{ id: number; date: string }>(
    db,
    `SELECT id, date FROM settlements WHERE ledger_id = ? AND inactive_at IS NULL AND import_row_id IN (${marks})`,
    ledgerId,
    ...rowIds,
  );
  for (const r of [...entries, ...settlements]) assertWritable(db, ledgerId, r.date, recalc);
  return tx(db, () => {
    for (const e of entries) {
      const before = snapshot(db, 'entry', e.id);
      run(db, `UPDATE entries SET inactive_at = datetime('now') WHERE id = ?`, e.id);
      if (touchesClosed(db, ledgerId, e.date)) logChange(db, ledgerId, actor.userId, 'entry', e.id, 'delete', before, null);
    }
    for (const s of settlements) run(db, `UPDATE settlements SET inactive_at = datetime('now') WHERE id = ?`, s.id);
    run(db, `UPDATE import_rows SET decision = 'pending' WHERE id IN (${marks})`, ...rowIds);
    run(db, 'UPDATE import_batches SET sent_at = NULL WHERE id = ?', batchId);
    return { entries: entries.length, settlements: settlements.length, rows: rowIds.length };
  });
}

export function listOpenImports(db: Db, ledgerId: number) {
  return all(
    db,
    `SELECT b.id, b.files, b.created_at createdAt, COUNT(r.id) pending
     FROM import_batches b JOIN import_rows r ON r.batch_id = b.id AND r.decision = 'pending'
     WHERE b.ledger_id = ? GROUP BY b.id ORDER BY b.id DESC`,
    ledgerId,
  ).map((b: any) => ({ ...b, files: JSON.parse(b.files) }));
}

export type Decision =
  | { rowId: number; action: 'skip' }
  | { rowId: number; action: 'income'; comment?: string; amount?: number; earnedBy?: number | null; tags?: string[] }
  // Строка сливается с расходом другой строки той же выписки: возврат к покупке, доплата, чаевые отдельным чеком
  | { rowId: number; action: 'merge'; intoRowId: number }
  | { rowId: number; action: 'settlement'; userId: number; comment?: string; amount?: number }
  | { rowId: number; action: 'expense'; tags?: string[]; parts: { fundId: number; amount: number; comment?: string; refundOf?: number | null }[] };

/** Применяет решения атомарно: ошибка в одной строке не оставляет половину пачки в учёте. */
export function applyDecisions(db: Db, ledgerId: number, batchId: number, actor: { userId: number; isAdmin: boolean }, decisions: Decision[]) {
  batchOwner(db, ledgerId, batchId, actor);
  // Выписка отправляется только целиком: решение нужно по каждой строке, которая ещё ждёт проверки
  const waiting = all<{ id: number }>(db, `SELECT id FROM import_rows WHERE batch_id = ? AND decision = 'pending'`, batchId).map((r) => r.id);
  const decided = new Set(decisions.map((d) => d.rowId));
  if (waiting.some((id) => !decided.has(id))) throw new DomainError('Выписка отправляется целиком: заполни все операции или пропусти лишние.');
  const paidBy = actor.isAdmin ? null : actor.userId;
  const base = get<{ currency: string }>(db, 'SELECT currency FROM ledgers WHERE id = ?', ledgerId)!.currency;

  // Слитые строки добавляют свою сумму (со знаком из выписки) к строке, с которой слиты
  const mergedInto = new Map<number, number>();
  const targets = new Map(decisions.map((d) => [d.rowId, d]));
  for (const d of decisions) {
    if (d.action !== 'merge') continue;
    const target = targets.get(d.intoRowId);
    if (d.intoRowId === d.rowId || target?.action !== 'expense') throw new DomainError('Объединить можно только с расходом или возвратом в этой же выписке.');
    const pair = all<{ id: number; amount: number; currency: string }>(db, `SELECT id, amount, currency FROM import_rows WHERE batch_id = ? AND id IN (?, ?)`, batchId, d.rowId, d.intoRowId);
    if (pair.length !== 2 || pair[0].currency !== pair[1].currency || pair[0].currency !== base) throw new DomainError('Объединяются операции в основной валюте из одной выписки.');
    const amount = pair.find((p) => p.id === d.rowId)!.amount;
    mergedInto.set(d.intoRowId, (mergedInto.get(d.intoRowId) ?? 0) + amount);
  }

  return tx(db, () => {
    let posted = 0;
    let merged = 0;
    for (const d of decisions) {
      const row = get<{ id: number; date: string; amount: number; currency: string; details: string; decision: string }>(
        db,
        'SELECT id, date, amount, currency, details, decision FROM import_rows WHERE id = ? AND batch_id = ?',
        d.rowId,
        batchId,
      );
      if (!row) throw new DomainError(`Строка ${d.rowId} не найдена`, 404);
      if (row.decision !== 'pending') throw new DomainError(`Строка «${row.details}» уже разобрана`);

      if (d.action === 'skip') {
        run(db, `UPDATE import_rows SET decision = 'skipped' WHERE id = ?`, row.id);
        continue;
      }
      if (d.action === 'merge') {
        // Сумма уже вошла в операцию строки, с которой слита
        run(db, `UPDATE import_rows SET decision = 'posted' WHERE id = ?`, row.id);
        merged++;
        continue;
      }
      assertWritable(db, ledgerId, row.date);
      // Операция в другой валюте проводится на сумму в основной, исходная остаётся в описании
      const foreign = row.currency !== base;
      const description = foreign ? `${row.details} (${Math.abs(row.amount) / 100} ${row.currency})` : row.details;
      const wholeAmount = (d: { amount?: number }) => {
        if (!foreign) return Math.abs(row.amount);
        if (!d.amount) throw new DomainError(`«${row.details}»: укажи сумму в ${base}.`);
        return d.amount;
      };

      if (d.action === 'income') {
        if (!actor.isAdmin) throw new DomainError('Доходы вносит администратор', 403);
        if (row.amount <= 0) throw new DomainError(`«${row.details}»: списание не может быть доходом.`);
        const earnedBy = d.earnedBy ?? null;
        if (earnedBy !== null && !get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, earnedBy)) {
          throw new DomainError('Участник не найден', 404);
        }
        const incomeId = run(
          db,
          `INSERT INTO entries (ledger_id, date, kind, amount, description, comment, earned_by, created_by, import_row_id)
           VALUES (?, ?, 'income', ?, ?, ?, ?, ?, ?)`,
          ledgerId,
          row.date,
          wholeAmount(d),
          description,
          d.comment ?? '',
          earnedBy,
          actor.userId,
          row.id,
        ).lastInsertRowid;
        setEntryTags(db, ledgerId, Number(incomeId), d.tags ?? []);
        noteEntries(db, ledgerId, actor.userId, [Number(incomeId)]);
      } else if (d.action === 'settlement') {
        if (!actor.isAdmin) throw new DomainError('Выплаты вносит администратор', 403);
        if (row.amount >= 0) throw new DomainError(`«${row.details}»: выплата участнику должна быть списанием.`);
        if (!get(db, 'SELECT 1 x FROM members WHERE ledger_id = ? AND user_id = ? AND inactive_at IS NULL', ledgerId, d.userId)) {
          throw new DomainError('Участник не найден', 404);
        }
        const settlementId = run(
          db,
          'INSERT INTO settlements (ledger_id, user_id, date, amount, comment, created_by, import_row_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ledgerId,
          d.userId,
          row.date,
          wholeAmount(d),
          d.comment ?? description,
          actor.userId,
          row.id,
        ).lastInsertRowid;
        noteSettlement(db, ledgerId, actor.userId, Number(settlementId), d.userId);
      } else {
        const effective = row.amount + (mergedInto.get(row.id) ?? 0);
        if (effective === 0) throw new DomainError(`«${row.details}»: вместе с объединёнными операциями выходит 0, такие операции лучше пропустить.`);
        const absolute = Math.abs(effective);
        const sum = d.parts.reduce((s, p) => s + p.amount, 0);
        if (!d.parts.length || (!foreign && sum !== absolute) || d.parts.some((p) => p.amount <= 0)) {
          throw new DomainError(`«${row.details}»: части должны давать в сумме ${absolute / 100} ${base}.`);
        }
        // Списание это расход, зачисление по фонду это возврат с минусом
        const sign = effective < 0 ? 1 : -1;
        for (const part of d.parts) {
          if (!get(db, 'SELECT 1 x FROM funds WHERE id = ? AND ledger_id = ?', part.fundId, ledgerId)) {
            throw new DomainError('Фонд не найден', 404);
          }
          const entryId = run(
            db,
            `INSERT INTO entries (ledger_id, date, kind, amount, fund_id, description, comment, paid_by, created_by, import_row_id, refund_of)
             VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?, ?)`,
            ledgerId,
            row.date,
            sign * part.amount,
            part.fundId,
            description,
            part.comment ?? '',
            paidBy,
            actor.userId,
            row.id,
            null,
          ).lastInsertRowid;
          // Привязка проверяется после вставки: так учитываются и другие возвраты из этой же выписки
          if (part.refundOf) {
            checkRefund(db, { ledgerId, ...actor }, Number(entryId), part.refundOf, 'expense', sign * part.amount);
            run(db, 'UPDATE entries SET refund_of = ? WHERE id = ?', part.refundOf, entryId);
          }
          setEntryTags(db, ledgerId, Number(entryId), d.tags ?? []);
          noteEntries(db, ledgerId, actor.userId, [Number(entryId)]);
        }
      }
      run(db, `UPDATE import_rows SET decision = 'posted' WHERE id = ?`, row.id);
      posted++;
    }
    run(db, `UPDATE import_batches SET sent_at = datetime('now') WHERE id = ?`, batchId);
    return { posted, merged, skipped: decisions.length - posted - merged };
  });
}
