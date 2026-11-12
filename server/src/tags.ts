import { all, get, run, tx, type Db } from './db.js';
import { DomainError } from './domain.js';
import { loadTagHistory, predictTags } from './tagModel.js';

export function normalizeTag(name: string): string {
  return name.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeTags(names: string[]): string[] {
  return [...new Set(names.map(normalizeTag).filter(Boolean))];
}

function tagIds(db: Db, ledgerId: number, names: string[]): number[] {
  return normalizeTags(names).map((name) => {
    run(db, 'INSERT INTO tags (ledger_id, name) VALUES (?, ?) ON CONFLICT (ledger_id, name) DO UPDATE SET inactive_at = NULL', ledgerId, name);
    return get<{ id: number }>(db, 'SELECT id FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, name)!.id;
  });
}

/** Заменяет теги операции. Новые названия становятся тегами базы. */
export function setEntryTags(db: Db, ledgerId: number, entryId: number, names: string[]): void {
  run(db, 'DELETE FROM entry_tags WHERE entry_id = ?', entryId);
  for (const id of tagIds(db, ledgerId, names)) run(db, 'INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)', entryId, id);
}

/** То же для корректировки свободных средств. */
export function setAdjustmentTags(db: Db, ledgerId: number, adjustmentId: number, names: string[]): void {
  run(db, 'DELETE FROM adjustment_tags WHERE adjustment_id = ?', adjustmentId);
  for (const id of tagIds(db, ledgerId, names)) run(db, 'INSERT OR IGNORE INTO adjustment_tags (adjustment_id, tag_id) VALUES (?, ?)', adjustmentId, id);
}

export function listTags(db: Db, ledgerId: number) {
  return all<{ id: number; name: string; count: number }>(
    db,
    `SELECT t.id, t.name,
       (SELECT COUNT(*) FROM entry_tags et JOIN entries e ON e.id = et.entry_id AND e.inactive_at IS NULL WHERE et.tag_id = t.id)
       + (SELECT COUNT(*) FROM adjustment_tags at JOIN adjustments a ON a.id = at.adjustment_id AND a.inactive_at IS NULL WHERE at.tag_id = t.id) count
     FROM tags t WHERE t.ledger_id = ? AND t.inactive_at IS NULL ORDER BY count DESC, t.name`,
    ledgerId,
  );
}

/**
 * Для ручной операции: теги по похожим прошлым операциям (тот же текст или продавец, та же сумма в фонде, тот же фонд).
 * auto ставятся сами, пока человек не трогал теги; frequent показываются первыми.
 */
export function suggestTags(db: Db, ledgerId: number, fundId: number | null, text: string, kind: 'expense' | 'income' = 'expense', amount: number | null = null) {
  const { auto, hints } = predictTags(loadTagHistory(db, ledgerId), { kind, text, fundId, amount });
  return { auto, frequent: hints };
}

/** Суммы расходов по тегам и месяцам. Операция с двумя тегами считается в каждом из них. */
export function tagStats(db: Db, ledgerId: number, hidden: Set<number> = new Set()) {
  const skip = hidden.size ? `AND (e.fund_id IS NULL OR e.fund_id NOT IN (${[...hidden].join(',')}))` : '';
  const rows = all<{ ym: string; tagId: number; name: string; total: number; count: number }>(
    db,
    `SELECT substr(e.date, 1, 7) ym, t.id tagId, t.name, SUM(e.amount) total, COUNT(*) count
     FROM entries e JOIN entry_tags et ON et.entry_id = e.id JOIN tags t ON t.id = et.tag_id
     WHERE e.ledger_id = ? AND e.kind = 'expense' AND e.inactive_at IS NULL AND t.inactive_at IS NULL ${skip} GROUP BY ym, t.id ORDER BY ym`,
    ledgerId,
  );
  const untagged = all<{ ym: string; total: number }>(
    db,
    `SELECT substr(e.date, 1, 7) ym, SUM(e.amount) total FROM entries e
     WHERE e.ledger_id = ? AND e.kind = 'expense' AND e.inactive_at IS NULL ${skip}
       AND NOT EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id = et.tag_id AND t.inactive_at IS NULL WHERE et.entry_id = e.id)
     GROUP BY ym ORDER BY ym`,
    ledgerId,
  );
  return { rows, untagged };
}

/** Переименование в уже существующий тег объединяет их. */
export function renameTag(db: Db, ledgerId: number, tagId: number, rawName: string): void {
  const name = normalizeTag(rawName);
  if (!name) throw new DomainError('Введи название тега.');
  if (!get(db, 'SELECT 1 x FROM tags WHERE id = ? AND ledger_id = ? AND inactive_at IS NULL', tagId, ledgerId)) throw new DomainError('Тег не найден', 404);
  const other = get<{ id: number }>(db, 'SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND id != ?', ledgerId, name, tagId);
  tx(db, () => {
    if (other) {
      run(db, 'INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) SELECT entry_id, ? FROM entry_tags WHERE tag_id = ?', other.id, tagId);
      run(db, 'INSERT OR IGNORE INTO adjustment_tags (adjustment_id, tag_id) SELECT adjustment_id, ? FROM adjustment_tags WHERE tag_id = ?', other.id, tagId);
      run(db, 'UPDATE tags SET inactive_at = NULL WHERE id = ?', other.id);
      run(db, `UPDATE tags SET inactive_at = datetime('now') WHERE id = ?`, tagId);
    } else {
      run(db, 'UPDATE tags SET name = ? WHERE id = ?', name, tagId);
    }
  });
}

export function deleteTag(db: Db, ledgerId: number, tagId: number): void {
  run(db, `UPDATE tags SET inactive_at = datetime('now') WHERE id = ? AND ledger_id = ?`, tagId, ledgerId);
}

/**
 * Доходы по категориям из тегов. Тег «зп …» (например, «зп основная», «зп подработка») это зарплата, она делится по людям («ЗП Игорь»).
 * Иначе категория это тот из тегов дохода, что чаще всего встречается у доходов базы; без тегов «Без тега».
 */
interface IncomeRow {
  id: number;
  ym: string;
  amount: number;
  who: string | null;
  earnedBy: number | null;
  tags: string[];
}

const SALARY_TAG = /^зп(\s|$)/;

function incomeRows(db: Db, ledgerId: number): IncomeRow[] {
  return all<Omit<IncomeRow, 'tags'> & { tags: string | null }>(
    db,
    `SELECT e.id, substr(e.date, 1, 7) ym, e.amount, m.display_name who, e.earned_by earnedBy,
       (SELECT json_group_array(t.name) FROM entry_tags x JOIN tags t ON t.id = x.tag_id AND t.inactive_at IS NULL WHERE x.entry_id = e.id) tags
     FROM entries e LEFT JOIN members m ON m.ledger_id = e.ledger_id AND m.user_id = e.earned_by
     WHERE e.ledger_id = ? AND e.kind = 'income' AND e.inactive_at IS NULL ORDER BY ym`,
    ledgerId,
  ).map((r) => ({ ...r, tags: JSON.parse(r.tags ?? '[]') as string[] }));
}

/** Категория дохода и тег, который её задаёт: «зп …» это зарплата человека, иначе самый частый тег. */
function categorize(rows: IncomeRow[]) {
  const usage = new Map<string, number>();
  for (const r of rows) for (const t of r.tags) usage.set(t, (usage.get(t) ?? 0) + 1);
  return (r: IncomeRow): { category: string; tag: string | null } => {
    const salary = r.tags.find((t) => SALARY_TAG.test(t));
    if (salary) {
      const person = r.who?.replace(/^[^\p{L}]+/u, '');
      return { category: person ? `ЗП ${person}` : 'ЗП', tag: salary };
    }
    if (!r.tags.length) return { category: 'Без тега', tag: null };
    const tag = [...r.tags].sort((a, b) => usage.get(b)! - usage.get(a)! || a.localeCompare(b, 'ru'))[0];
    return { category: tag[0].toUpperCase() + tag.slice(1), tag };
  };
}

export function incomeCategories(db: Db, ledgerId: number): { ym: string; category: string; total: number }[] {
  const rows = incomeRows(db, ledgerId);
  const categoryOf = categorize(rows);
  const totals = new Map<string, { ym: string; category: string; total: number }>();
  for (const r of rows) {
    const { category } = categoryOf(r);
    const key = `${r.ym}|${category}`;
    const item = totals.get(key) ?? { ym: r.ym, category, total: 0 };
    item.total += r.amount;
    totals.set(key, item);
  }
  return [...totals.values()];
}

/**
 * Категории для выбора при внесении дохода: тег категории и, для зарплаты, чей доход.
 * Порядок по частоте, чтобы частые категории были сверху.
 */
export function incomeCategoryOptions(db: Db, ledgerId: number): { category: string; tag: string; earnedBy: number | null; count: number }[] {
  const rows = incomeRows(db, ledgerId);
  const categoryOf = categorize(rows);
  const options = new Map<string, { category: string; tags: Map<string, number>; earnedBy: number | null; count: number }>();
  for (const r of rows) {
    const { category, tag } = categoryOf(r);
    if (!tag) continue;
    const item = options.get(category) ?? { category, tags: new Map(), earnedBy: SALARY_TAG.test(tag) ? r.earnedBy : null, count: 0 };
    item.tags.set(tag, (item.tags.get(tag) ?? 0) + 1);
    item.count++;
    options.set(category, item);
  }
  return [...options.values()]
    .map((o) => ({ category: o.category, tag: [...o.tags.entries()].sort((a, b) => b[1] - a[1])[0][0], earnedBy: o.earnedBy, count: o.count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category, 'ru'));
}
