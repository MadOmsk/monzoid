import { all, type Db } from './db.js';
import { merchantKey } from './statements/classify.js';

/**
 * Подсказка тегов по истории. Теги ищутся у похожих прошлых операций трёх видов:
 * - тот же продавец (ключ продавца из выписки или тот же текст комментария/описания);
 * - та же сумма в том же фонде (подписки, садик, коммуналка: сумма повторяется, продавец бывает разный);
 * - тот же фонд (просто частые теги).
 * Для каждого вида считается доля операций с тегом; свежие операции весят больше (вес вдвое меньше каждые полгода).
 * Тег ставится сам, только если у продавца или повторяющейся суммы он стоит почти всегда; остальное это подсказки.
 * Отдельно ничего не хранится: человек снял тег, операция сохранилась без него, и доля сама упала.
 */

const HISTORY_DAYS = 730;
const MAX_HISTORY = 5000;
const HALF_LIFE_DAYS = 180;
/** Доля похожих операций с тегом, при которой тег ставится сам */
const AUTO_SHARE = 0.7;
/** Повторяющаяся сумма: доля и сколько раз она должна встретиться */
const RECURRING_AUTO_SHARE = 0.8;
const RECURRING_MIN = 3;
/** Сумма считается той же, если отличается не больше чем на столько */
const AMOUNT_TOLERANCE = 0.03;
/** Ниже этой доли тег продавца или суммы не подсказывается */
const HINT_SHARE = 0.2;
const MAX_HINTS = 8;

export interface TagSample {
  date: string;
  kind: string;
  fundId: number | null;
  amount: number;
  merchant: string;
  texts: string[];
  tags: string[];
}

export interface TagContext {
  kind: 'expense' | 'income';
  /** Ключ продавца из выписки; для ручной операции берётся из текста */
  merchant?: string;
  /** Комментарий или банковское описание */
  text?: string;
  fundId?: number | null;
  /** Сумма в тиынах, знак не важен */
  amount?: number | null;
  today?: string;
}

export interface TagPrediction {
  /** Ставятся сами */
  auto: string[];
  /** Показываются первыми среди тегов: сначала автоматические (снятый легко вернуть), затем остальные по убыванию */
  hints: string[];
}

const cleanText = (text: string) => text.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/** Ключ продавца для ручного текста: короткий или пустой не годится, слишком много совпадений. */
function keyOf(text: string): string {
  const key = merchantKey(text);
  return key.length >= 3 ? key : '';
}

/** Операции с тегами за последние два года, новые первыми. Загружается один раз на выписку. */
export function loadTagHistory(db: Db, ledgerId: number): TagSample[] {
  const rows = all<{ date: string; kind: string; fundId: number | null; amount: number; merchant: string | null; comment: string; description: string; tags: string }>(
    db,
    `SELECT e.date, e.kind, e.fund_id fundId, e.amount, r.merchant_key merchant, e.comment, e.description,
       (SELECT json_group_array(t.name) FROM entry_tags et JOIN tags t ON t.id = et.tag_id AND t.inactive_at IS NULL WHERE et.entry_id = e.id) tags
     FROM entries e LEFT JOIN import_rows r ON r.id = e.import_row_id
     WHERE e.ledger_id = ? AND e.inactive_at IS NULL AND e.auto_credit = 0 AND e.date >= date('now', '-${HISTORY_DAYS} days')
     ORDER BY e.date DESC, e.id DESC LIMIT ${MAX_HISTORY}`,
    ledgerId,
  );
  return rows.map((r) => ({
    date: r.date,
    kind: r.kind,
    fundId: r.fundId,
    amount: Math.abs(r.amount),
    merchant: r.merchant || keyOf(r.description) || keyOf(r.comment),
    texts: [r.comment, r.description].map(cleanText).filter(Boolean),
    tags: JSON.parse(r.tags) as string[],
  }));
}

interface Group {
  count: number;
  weight: number;
  byTag: Map<string, number>;
}

function group(samples: TagSample[], today: string): Group {
  const now = Date.parse(today);
  const byTag = new Map<string, number>();
  let weight = 0;
  for (const s of samples) {
    const age = Math.max(0, (now - Date.parse(s.date)) / 86_400_000);
    const w = 0.5 ** (age / HALF_LIFE_DAYS);
    weight += w;
    for (const t of s.tags) byTag.set(t, (byTag.get(t) ?? 0) + w);
  }
  return { count: samples.length, weight, byTag };
}

const share = (g: Group, tag: string) => (g.weight ? (g.byTag.get(tag) ?? 0) / g.weight : 0);

export function predictTags(history: TagSample[], ctx: TagContext): TagPrediction {
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const sameKind = history.filter((s) => s.kind === ctx.kind);
  const text = cleanText(ctx.text ?? '');
  const merchant = ctx.merchant || (text ? keyOf(text) : '');
  const amount = ctx.amount ? Math.abs(ctx.amount) : null;
  const fundId = ctx.fundId ?? null;

  // Тот же продавец. Если он встречался в этом фонде хотя бы дважды, берутся только эти операции:
  // у маркетплейса теги зависят от того, что купили
  const sellerAll = sameKind.filter((s) => (merchant && s.merchant === merchant) || (text && s.texts.includes(text)));
  const sellerInFund = fundId ? sellerAll.filter((s) => s.fundId === fundId) : [];
  const sellerSamples = sellerInFund.length >= 2 ? sellerInFund : sellerAll;
  const seller = group(sellerSamples, today);
  const recurring = group(
    amount && fundId ? sameKind.filter((s) => s.fundId === fundId && Math.abs(s.amount - amount) <= amount * AMOUNT_TOLERANCE) : [],
    today,
  );
  const fund = group(ctx.kind === 'income' ? sameKind : fundId ? sameKind.filter((s) => s.fundId === fundId) : [], today);

  const auto = new Set<string>();
  for (const tag of seller.byTag.keys()) {
    // Одна прошлая операция с тем же текстом тоже считается: так было и раньше, и это почти всегда верно
    const exactOnce = seller.count === 1 && !!text && sellerSamples[0].texts.includes(text);
    if ((seller.count >= 2 && share(seller, tag) >= AUTO_SHARE) || exactOnce) auto.add(tag);
  }
  for (const tag of recurring.byTag.keys()) {
    if (recurring.count >= RECURRING_MIN && share(recurring, tag) >= RECURRING_AUTO_SHARE) auto.add(tag);
  }

  const score = new Map<string, number>();
  const add = (g: Group, k: number, min: number) => {
    for (const tag of g.byTag.keys()) {
      const s = share(g, tag);
      if (s >= min) score.set(tag, (score.get(tag) ?? 0) + k * s);
    }
  };
  add(seller, 3, HINT_SHARE);
  add(recurring, 2, HINT_SHARE);
  add(fund, 1, 0);
  const autoList = [...auto].sort();
  const rest = [...score.entries()]
    .filter(([tag]) => !auto.has(tag))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
  return { auto: autoList, hints: [...autoList, ...rest].slice(0, Math.max(MAX_HINTS, autoList.length)) };
}
