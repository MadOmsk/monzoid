import { createHash } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export type Bank = 'kaspi' | 'freedom';

export interface StatementRow {
  hash: string;
  bank: Bank;
  account: string;
  /** ISO-дата YYYY-MM-DD */
  date: string;
  /** Со знаком из выписки, в минимальных единицах валюты */
  amount: number;
  currency: string;
  op: string;
  details: string;
  pending: boolean;
}

export interface ParsedStatement {
  bank: Bank;
  account: string;
  rows: StatementRow[];
  pendingCount: number;
  warnings: string[];
}

interface Item {
  page: number;
  x: number;
  y: number;
  text: string;
}

export class StatementError extends Error {}

const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/;
const AMOUNT_RE = /^[+-]\s?[\d\s., ]+\s?[₸$€]?$/;
const NOISE_RE =
  /^(АО «|АО "|Подлинность справки|просканировав|https?:|Приложение к Справке|Раздел «|счета» содержит|- Сумма заблокирована|Управляющий директор)/;

// Колонка «Детали» начинается с этой координаты, левее неё лежит «Операция»
const DETAILS_X: Record<Bank, number> = { kaspi: 300, freedom: 380 };
// Детали из нескольких строк расходятся вокруг даты не дальше половины высоты записи
const MAX_ROW_DY: Record<Bank, number> = { kaspi: 7, freedom: 13 };

async function readItems(data: Uint8Array): Promise<Item[]> {
  let doc;
  try {
    doc = await getDocument({ data, verbosity: 0, isEvalSupported: false }).promise;
  } catch {
    throw new StatementError('Не получилось открыть файл. Нужен PDF-файл выписки из банка.');
  }
  const items: Item[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const raw of content.items) {
      if (!('str' in raw) || !raw.str.trim()) continue;
      items.push({ page, x: raw.transform[4], y: raw.transform[5], text: raw.str.trim() });
    }
  }
  await doc.destroy();
  return items;
}

function detectBank(text: string): Bank {
  if (/Kaspi Gold|CASPKZKA/.test(text)) return 'kaspi';
  if (/bankffin|KSNVKZKA|Фридом/.test(text)) return 'freedom';
  throw new StatementError('Формат выписки не распознан. Пока поддерживаются Kaspi Gold и Freedom Bank.');
}

function parseMoney(raw: string, bank: Bank): { amount: number; currency: string } {
  const currency = raw.includes('$') ? 'USD' : raw.includes('€') ? 'EUR' : 'KZT';
  const sign = raw.trim().startsWith('-') ? -1 : 1;
  let digits = raw.replace(/[+\-₸$€\s ]/g, '');
  // Kaspi: «10 800,00», Freedom: «10,800.00»
  digits = bank === 'kaspi' ? digits.replace(',', '.') : digits.replace(/,/g, '');
  return { amount: sign * Math.round(Number(digits) * 100), currency };
}

function isoDate(raw: string): string {
  const m = DATE_RE.exec(raw)!;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[2]}-${m[1]}`;
}

/** Итоги банка из шапки: метка → сумма в тиынах. */
function readSummary(items: Item[], bank: Bank): Map<string, number> {
  const summary = new Map<string, number>();
  const labels =
    bank === 'kaspi'
      ? ['Пополнения', 'Переводы', 'Покупки', 'Снятия', 'Разное']
      : ['Платеж', 'Перевод', 'Покупка', 'Снятие', 'Пополнение', 'Другое'];
  const header = items.find((i) => i.text === 'Дата');
  for (const item of items) {
    if (!labels.includes(item.text)) continue;
    if (header && (item.page > header.page || (item.page === header.page && item.y <= header.y))) continue;
    const value = items.find(
      (o) => o.page === item.page && Math.abs(o.y - item.y) < 2 && o.x > item.x && AMOUNT_RE.test(o.text),
    );
    if (value) summary.set(item.text, parseMoney(value.text, bank).amount);
  }
  return summary;
}

const KASPI_LABELS: Record<string, string> = {
  Перевод: 'Переводы',
  Покупка: 'Покупки',
  Пополнение: 'Пополнения',
  Снятие: 'Снятия',
  Разное: 'Разное',
};
// Верхняя граница курса: валютная строка в итогах банка идёт в тенге, а курса в выписке нет
const MAX_KZT_PER_FOREIGN_UNIT = 1000;

function reconcile(rows: StatementRow[], summary: Map<string, number>, bank: Bank): string[] {
  const totals = new Map<string, number>();
  const foreign = new Map<string, number>();
  for (const row of rows) {
    if (row.pending) continue;
    const label = bank === 'kaspi' ? (KASPI_LABELS[row.op] ?? row.op) : row.op;
    if (row.currency !== 'KZT') {
      foreign.set(label, (foreign.get(label) ?? 0) + Math.abs(row.amount));
      continue;
    }
    // В итогах Freedom возвраты по покупкам не вычитаются, а прибавляются к сумме покупок
    const value = bank === 'freedom' && row.op === 'Покупка' ? -Math.abs(row.amount) : row.amount;
    totals.set(label, (totals.get(label) ?? 0) + value);
  }
  const warnings: string[] = [];
  for (const [label, expected] of summary) {
    const actual = totals.get(label) ?? 0;
    const gap = Math.abs(actual - expected);
    if (gap > (foreign.get(label) ?? 0) * MAX_KZT_PER_FOREIGN_UNIT) {
      warnings.push(
        `«${label}»: в итогах банка ${(expected / 100).toFixed(2)} ₸, в разобранных строках ${(actual / 100).toFixed(2)} ₸. Сверь эту выписку внимательнее.`,
      );
    }
  }
  return warnings;
}

export function parseItems(items: Item[]): ParsedStatement {
  const fullText = items.map((i) => i.text).join(' ');
  const bank = detectBank(fullText);
  const account = /\*{1,2}(\d{4})/.exec(fullText)?.[1] ?? '';

  const header = items.find((i) => i.text === 'Дата');
  if (!header) throw new StatementError('В файле не найдена таблица операций.');
  const isTable = (i: Item) => i.page > header.page || (i.page === header.page && i.y < header.y);
  const tableItems = items.filter((i) => isTable(i) && !NOISE_RE.test(i.text) && !/^(Дата|Сумма|Валюта|Операция|Детали)$/.test(i.text));

  const anchors = tableItems.filter((i) => DATE_RE.test(i.text) && i.x < 100);
  const buckets = new Map<Item, Item[]>(anchors.map((a) => [a, []]));
  for (const item of tableItems) {
    if (buckets.has(item)) continue;
    let best: Item | undefined;
    for (const a of anchors) {
      if (a.page !== item.page) continue;
      if (!best || Math.abs(a.y - item.y) < Math.abs(best.y - item.y)) best = a;
    }
    if (best && Math.abs(best.y - item.y) <= MAX_ROW_DY[bank]) buckets.get(best)!.push(item);
  }

  const rows: Omit<StatementRow, 'hash'>[] = [];
  let unreadable = 0;
  for (const [anchor, cells] of buckets) {
    cells.sort((a, b) => b.y - a.y || a.x - b.x);
    const amountCell = cells.find((c) => c.x < DETAILS_X[bank] && AMOUNT_RE.test(c.text));
    if (!amountCell) {
      unreadable++;
      continue;
    }
    const { amount, currency } = parseMoney(amountCell.text, bank);
    const left = cells.filter((c) => c !== amountCell && c.x < DETAILS_X[bank] && c.text !== currency);
    const op = left.map((c) => c.text).join(' ');
    const details = cells
      .filter((c) => c.x >= DETAILS_X[bank])
      .map((c) => c.text)
      .join(' ');
    rows.push({ bank, account, date: isoDate(anchor.text), amount, currency, op, details, pending: /обработке/.test(op) });
  }

  // Две одинаковые покупки в один день различаются порядковым номером
  const seen = new Map<string, number>();
  const hashed: StatementRow[] = rows.map((r) => {
    const key = [r.bank, r.account, r.date, r.amount, r.currency, r.op, r.details].join('|');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { ...r, hash: createHash('sha256').update(`${key}|${n}`).digest('hex') };
  });

  const warnings = reconcile(hashed, readSummary(items, bank), bank);
  if (unreadable) warnings.push(`Не удалось прочитать строк: ${unreadable}. Проверь их вручную по выписке.`);
  const pendingCount = hashed.filter((r) => r.pending).length;
  return { bank, account, rows: hashed, pendingCount, warnings };
}

export async function parseStatement(data: Uint8Array): Promise<ParsedStatement> {
  return parseItems(await readItems(data));
}
