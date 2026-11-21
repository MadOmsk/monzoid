import { all, get, run, type Db } from './db.js';
import { syncInterest } from './interest.js';

interface Linked {
  potId: number;
  date: string;
  amount: number;
  comment: string;
}

/**
 * Деньги от продажи актива во вклад. Если у продажи указан вклад (to_pot_id), в нём есть перевод на сумму продажи
 * в день продажи, а каждый расход по этому активу с даты продажи (до следующей покупки) забирается из того же вклада
 * в день расхода. Свободные средства от такой продажи и её расходов не меняются: всё остаётся во вкладе.
 * Эти записи следуют за продажей и расходами и руками не правятся; функция приводит их в соответствие после любой записи.
 */
export function syncProceeds(db: Db, ledgerId: number): void {
  // Проценты по депозиту тоже следуют за операцией дохода
  syncInterest(db, ledgerId);
  const sales = all<{ id: number; potId: number; date: string; amount: number; toPotId: number; name: string }>(
    db,
    `SELECT m.id, m.pot_id potId, m.date, m.amount, m.to_pot_id toPotId, p.name FROM pot_moves m JOIN pots p ON p.id = m.pot_id
     WHERE p.ledger_id = ? AND p.kind = 'asset' AND m.amount < 0 AND m.to_pot_id IS NOT NULL AND m.inactive_at IS NULL`,
    ledgerId,
  );
  const wanted = new Map<string, Linked>();
  for (const sale of sales) {
    wanted.set(`${sale.id}:0`, { potId: sale.toPotId, date: sale.date, amount: -sale.amount, comment: `Продажа: ${sale.name}` });
    // Расходы после продажи относятся к ней, пока актив не куплен снова
    const nextBuy = get<{ date: string | null }>(
      db,
      'SELECT MIN(date) date FROM pot_moves WHERE pot_id = ? AND amount > 0 AND date > ? AND inactive_at IS NULL',
      sale.potId,
      sale.date,
    )?.date;
    const spent = all<{ id: number; date: string; amount: number; comment: string; description: string }>(
      db,
      `SELECT id, date, amount, comment, description FROM entries
       WHERE ledger_id = ? AND pot_id = ? AND kind = 'expense' AND inactive_at IS NULL AND date >= ? AND (? IS NULL OR date < ?)`,
      ledgerId,
      sale.potId,
      sale.date,
      nextBuy ?? null,
      nextBuy ?? null,
    );
    for (const e of spent) {
      wanted.set(`${sale.id}:${e.id}`, { potId: sale.toPotId, date: e.date, amount: -e.amount, comment: `${e.comment || e.description || 'Расход'}: ${sale.name}` });
    }
  }
  const existing = all<{ id: number; saleId: number; entryId: number | null; potId: number; date: string; amount: number; comment: string }>(
    db,
    `SELECT m.id, m.sale_move_id saleId, m.entry_id entryId, m.pot_id potId, m.date, m.amount, m.comment FROM pot_moves m JOIN pots p ON p.id = m.pot_id
     WHERE p.ledger_id = ? AND m.sale_move_id IS NOT NULL AND m.inactive_at IS NULL`,
    ledgerId,
  );
  for (const row of existing) {
    const key = `${row.saleId}:${row.entryId ?? 0}`;
    const want = wanted.get(key);
    wanted.delete(key);
    if (!want || want.amount === 0) {
      run(db, `UPDATE pot_moves SET inactive_at = datetime('now') WHERE id = ?`, row.id);
    } else if (want.potId !== row.potId || want.date !== row.date || want.amount !== row.amount || want.comment !== row.comment) {
      run(db, 'UPDATE pot_moves SET pot_id = ?, date = ?, amount = ?, comment = ? WHERE id = ?', want.potId, want.date, want.amount, want.comment, row.id);
    }
  }
  for (const [key, want] of wanted) {
    if (want.amount === 0) continue;
    const [saleId, entryId] = key.split(':').map(Number);
    run(
      db,
      'INSERT INTO pot_moves (pot_id, date, amount, units, comment, sale_move_id, entry_id) VALUES (?, ?, ?, 0, ?, ?, ?)',
      want.potId,
      want.date,
      want.amount,
      want.comment,
      saleId,
      entryId || null,
    );
  }
}
