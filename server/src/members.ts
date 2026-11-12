import { all, get, run, type Db } from './db.js';

/** Буквы имени в нижнем регистре: «🐻Иван» и «Личные: Иван» сравниваются по «иван». */
const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Личный фонд участника: фонд, выбранный на экране участника (funds.owner_user_id). null, если не выбран. */
export function personalFunds(db: Db, ledgerId: number, members: { userId: number; name: string }[]) {
  const funds = all<{ id: number; name: string; ownerUserId: number | null }>(
    db,
    'SELECT id, name, owner_user_id ownerUserId FROM funds WHERE ledger_id = ? ORDER BY archived, sort, id',
    ledgerId,
  );
  return new Map(
    members.map((m) => {
      const fund = funds.find((f) => f.ownerUserId === m.userId);
      return [m.userId, fund ? { id: fund.id, name: fund.name } : null] as const;
    }),
  );
}

/**
 * Разовая привязка при появлении колонки owner_user_id: фонд с начислениями участнику, иначе единственный фонд,
 * в названии которого есть имя участника отдельным словом («Личные: Иван»). Раньше связь так и угадывалась.
 */
export function assignPersonalFunds(db: Db): void {
  run(db, 'UPDATE funds SET owner_user_id = credit_user_id WHERE credit_user_id IS NOT NULL');
  const members = all<{ ledgerId: number; userId: number; name: string }>(db, 'SELECT ledger_id ledgerId, user_id userId, display_name name FROM members WHERE inactive_at IS NULL');
  for (const m of members) {
    if (get(db, 'SELECT 1 x FROM funds WHERE ledger_id = ? AND owner_user_id = ?', m.ledgerId, m.userId)) continue;
    const name = letters(m.name);
    if (!name) continue;
    const matches = all<{ id: number; name: string }>(db, 'SELECT id, name FROM funds WHERE ledger_id = ? AND owner_user_id IS NULL', m.ledgerId)
      .filter((f) => letters(f.name).split(' ').includes(name));
    if (matches.length === 1) run(db, 'UPDATE funds SET owner_user_id = ? WHERE id = ?', m.userId, matches[0].id);
  }
}

/**
 * Статистика по людям: по месяцам расходы участника за свой счёт (начисления отдельно), выплаты ему,
 * траты из его личного фонда; и на что он тратил свои деньги по фондам.
 */
export function memberStats(db: Db, ledgerId: number) {
  const members = all<{ userId: number; name: string }>(
    db,
    'SELECT user_id userId, display_name name FROM members WHERE ledger_id = ? AND inactive_at IS NULL ORDER BY role, display_name',
    ledgerId,
  );
  const fundOf = personalFunds(db, ledgerId, members);
  const months = all<{ ym: string; userId: number; credit: number; spent: number; paid: number; fundSpent: number }>(
    db,
    `SELECT ym, user_id userId, SUM(credit) credit, SUM(spent) spent, SUM(paid) paid, 0 fundSpent FROM (
       SELECT substr(date, 1, 7) ym, paid_by user_id, CASE WHEN auto_credit = 1 THEN amount ELSE 0 END credit, CASE WHEN auto_credit = 1 THEN 0 ELSE amount END spent, 0 paid
       FROM entries WHERE ledger_id = ? AND paid_by IS NOT NULL AND inactive_at IS NULL
       UNION ALL SELECT substr(date, 1, 7), user_id, 0, 0, amount FROM settlements WHERE ledger_id = ? AND inactive_at IS NULL
     ) GROUP BY ym, user_id ORDER BY ym`,
    ledgerId,
    ledgerId,
  );
  // Траты из личного фонда кем бы ни были оплачены; начисления это не траты
  for (const m of members) {
    const fund = fundOf.get(m.userId);
    if (!fund) continue;
    const spent = all<{ ym: string; total: number }>(
      db,
      `SELECT substr(date, 1, 7) ym, SUM(amount) total FROM entries
       WHERE ledger_id = ? AND fund_id = ? AND kind = 'expense' AND auto_credit = 0 AND inactive_at IS NULL GROUP BY ym`,
      ledgerId,
      fund.id,
    );
    for (const s of spent) {
      const row = months.find((r) => r.ym === s.ym && r.userId === m.userId);
      if (row) row.fundSpent = s.total;
      else months.push({ ym: s.ym, userId: m.userId, credit: 0, spent: 0, paid: 0, fundSpent: s.total });
    }
  }
  months.sort((a, b) => a.ym.localeCompare(b.ym));
  const byFund = all<{ userId: number; fundId: number; fundName: string; total: number; count: number }>(
    db,
    `SELECT e.paid_by userId, e.fund_id fundId, f.name fundName, SUM(e.amount) total, COUNT(*) count
     FROM entries e JOIN funds f ON f.id = e.fund_id
     WHERE e.ledger_id = ? AND e.paid_by IS NOT NULL AND e.auto_credit = 0 AND e.kind = 'expense' AND e.inactive_at IS NULL
     GROUP BY e.paid_by, e.fund_id ORDER BY total DESC`,
    ledgerId,
  );
  return {
    members: members.map((m) => ({ ...m, fund: fundOf.get(m.userId) ?? null })),
    months,
    byFund,
  };
}
