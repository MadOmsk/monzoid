import type { StatementRow } from './parse.js';

export type RowAction = 'expense' | 'income' | 'skip' | 'settlement';

export interface Suggestion {
  action: RowAction;
  userId?: number;
  hint: string;
}

const PAIR_WINDOW_DAYS = 5;
const REFUND_WINDOW_DAYS = 30;
const REFUND_RE = /^Возврат\.?\s*(Отмена покупки)?\s*/i;

/** Ключ продавца: одинаковый для всех покупок в одном месте, без номеров и города-страны. */
export function merchantKey(details: string): string {
  return details
    .replace(REFUND_RE, '')
    .toUpperCase()
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\b(KZ|ALMATY|QONAEV|KONAEV|KAPSHAGAY|KAPCHAGAY)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isRefund(row: Pick<StatementRow, 'details' | 'amount'>): boolean {
  return row.amount > 0 && REFUND_RE.test(row.details);
}

function isTransferLike(row: StatementRow): boolean {
  return /Перевод|Пополнение/.test(row.op) && !/Безвозмездный/.test(row.details);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/** Покупки в банковских строках можно отправлять на подсказку: в них нет имён людей. */
export function isAiEligible(row: StatementRow): boolean {
  return row.pending || /Покупка|Платеж/.test(row.op);
}

/**
 * Первичный разбор пачки без AI. Строки только помечаются: что из этого действительно
 * попадёт в учёт, решает человек на экране проверки.
 */
export function suggestActions(rows: StatementRow[], members: { userId: number; name: string }[], base = 'KZT'): Map<string, Suggestion> {
  const out = new Map<string, Suggestion>();
  const used = new Set<string>();

  for (const row of rows) {
    if (/Между своими счетами/i.test(row.details)) {
      out.set(row.hash, { action: 'skip', hint: 'Перевод между своими счетами' });
      used.add(row.hash);
    }
  }

  // Покупка и её отмена гасят друг друга
  for (const refund of rows) {
    if (used.has(refund.hash) || !isRefund(refund)) continue;
    const key = merchantKey(refund.details);
    const match = rows.find(
      (r) =>
        !used.has(r.hash) &&
        r.amount === -refund.amount &&
        r.currency === refund.currency &&
        r.account === refund.account &&
        daysBetween(r.date, refund.date) <= REFUND_WINDOW_DAYS &&
        (!key || merchantKey(r.details) === key),
    );
    if (match) {
      for (const r of [refund, match]) {
        out.set(r.hash, { action: 'skip', hint: 'Покупка и её отмена на одну сумму' });
        used.add(r.hash);
      }
    }
  }

  // Списание в одном банке и такое же зачисление в другом
  for (const out_ of rows) {
    if (used.has(out_.hash) || out_.amount >= 0 || !isTransferLike(out_)) continue;
    const match = rows
      .filter(
        (r) =>
          !used.has(r.hash) &&
          r.amount === -out_.amount &&
          r.currency === out_.currency &&
          r.account !== out_.account &&
          isTransferLike(r) &&
          daysBetween(r.date, out_.date) <= PAIR_WINDOW_DAYS,
      )
      .sort((a, b) => daysBetween(a.date, out_.date) - daysBetween(b.date, out_.date))[0];
    if (match) {
      for (const r of [out_, match]) {
        out.set(r.hash, { action: 'skip', hint: 'Похоже на перевод между своими картами: есть встречная сумма' });
        used.add(r.hash);
      }
    }
  }

  for (const row of rows) {
    if (used.has(row.hash)) continue;
    if (row.amount > 0) {
      if (isRefund(row)) out.set(row.hash, { action: 'expense', hint: 'Возврат: уменьшит расход по фонду' });
      else if (/С карты другого банка/i.test(row.details))
        out.set(row.hash, { action: 'skip', hint: 'Пополнение с другой карты: встречной суммы нет, проверь' });
      else out.set(row.hash, { action: 'income', hint: 'Поступление: проверь, что это действительно доход' });
      continue;
    }
    if (/Перевод/.test(row.op)) {
      const member = members.find((m) => {
        // В имени могут быть эмодзи: сравнивается первое слово из букв
        const first = m.name.replace(/[^\p{L}\s-]/gu, ' ').trim().toLowerCase().split(/\s+/)[0];
        return !!first && row.details.toLowerCase().startsWith(first);
      });
      if (member) {
        out.set(row.hash, { action: 'settlement', userId: member.userId, hint: `Перевод участнику: выплата долга или расход?` });
      } else {
        out.set(row.hash, { action: 'expense', hint: 'Перевод человеку: выбери фонд или пропусти' });
      }
      continue;
    }
    out.set(row.hash, { action: 'expense', hint: '' });
  }

  // Банк может списать часть в валюте, а остаток в основной: это две строки одной операции
  for (const row of rows) {
    const suggestion = out.get(row.hash);
    if (row.currency === base || suggestion?.action !== 'expense') continue;
    const other = rows.find((r) => r.currency === base && r.date === row.date && r.account === row.account && r.op === row.op && Math.sign(r.amount) === Math.sign(row.amount));
    if (other) out.set(row.hash, { ...suggestion, hint: 'Похоже, это часть операции: остаток банк провёл отдельной строкой в основной валюте, выбери для неё тот же фонд' });
  }
  return out;
}
