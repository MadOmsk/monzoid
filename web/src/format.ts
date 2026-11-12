const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export const BASE_CURRENCIES: [string, string][] = [
  ['KZT', 'Тенге, ₸'], ['USD', 'Доллар, $'], ['EUR', 'Евро, €'], ['RUB', 'Рубль, ₽'], ['KGS', 'Сом, сом'],
  ['UZS', 'Сум, сум'], ['GBP', 'Фунт, £'], ['TRY', 'Лира, ₺'], ['CNY', 'Юань, ¥'], ['AED', 'Дирхам, AED'],
];
const SYMBOLS: Record<string, string> = { KZT: '₸', USD: '$', EUR: '€', RUB: '₽', KGS: 'сом', UZS: 'сум', GBP: '£', TRY: '₺', CNY: '¥', AED: 'AED' };

// Экран показывает одну базу за раз, поэтому основная валюта задаётся один раз при её открытии
let baseSymbol = '₸';

export function setBaseCurrency(code: string): void {
  baseSymbol = SYMBOLS[code] ?? code;
}

export function symbol(code?: string): string {
  return code ? (SYMBOLS[code] ?? code) : baseSymbol;
}

/** Суммы приходят в сотых долях валюты, на экране округляются до целых. */
export function money(tiyn: number): string {
  return `${number.format(Math.round(tiyn / 100)).replace('-', '−')} ${baseSymbol}`;
}

/** Для таблиц, где знак валюты вынесен в заголовок. */
export function cell(tiyn: number): string {
  return number.format(Math.round(tiyn / 100)).replace('-', '−');
}

export function signedCell(tiyn: number): string {
  return tiyn > 0 ? `+${cell(tiyn)}` : cell(tiyn);
}

/** То же со знаком валюты. */
export function moneyRounded(tiyn: number): string {
  return `${cell(tiyn)} ${baseSymbol}`;
}

export function signedRounded(tiyn: number): string {
  return `${signedCell(tiyn)} ${baseSymbol}`;
}

/** Класс цвета для остатка или дельты: минус красный, плюс зелёный, ноль без цвета. */
export function tone(value: number): string {
  return value < 0 ? 'negative' : value > 0 ? 'positive' : '';
}

/** Цена единицы или количество: дробная часть важна, суммы в ней не округляются до целых. */
export function amount(value: number, digits = 2): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value).replace('-', '−');
}

/** «1,5» → 1.5. Пустая или неверная строка даёт null. */
export function parseUnits(text: string): number | null {
  const cleaned = text.replace(/\s/g, '').replace(',', '.').replace('−', '-');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
}

export function signed(tiyn: number): string {
  return tiyn > 0 ? `+${money(tiyn)}` : money(tiyn);
}

/** «10 800,50» → 1080050. Пустая или неверная строка даёт null. */
export function parseMoney(text: string): number | null {
  const cleaned = text.replace(/[\s ₸]/g, '').replace(',', '.').replace('−', '-');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Фильтр поля суммы при вводе: только цифры, пробелы между разрядами и один разделитель (точка или запятая).
 * minus: можно начать с минуса (план, корректировка, вывод из вклада); decimals: знаков после разделителя.
 */
export function numberInput(text: string, { minus = false, decimals = 2 } = {}): string {
  let s = text.replace(/−/g, '-').replace(/[^\d\s\u00a0.,-]/g, '');
  const negative = minus && /^\s*-/.test(s);
  s = s.replace(/-/g, '');
  const sep = s.search(/[.,]/);
  if (sep >= 0) s = s.slice(0, sep + 1) + s.slice(sep + 1).replace(/[^\d]/g, '').slice(0, decimals);
  if (decimals === 0) s = s.replace(/[.,]/g, '');
  return (negative ? '-' : '') + s;
}

export function toInput(tiyn: number): string {
  return tiyn === 0 ? '' : String(tiyn / 100);
}

/** Как toInput, но с пробелами между разрядами: так длинные суммы читаются в узком поле. parseMoney пробелы убирает. */
export function toGroupedInput(tiyn: number): string {
  return tiyn === 0 ? '' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(tiyn / 100);
}

export function monthName(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function monthShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${SHORT[m - 1]} ${String(y).slice(2)}`;
}

export function shiftYm(ym: string, by: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * «5 окт». Месяц словом: «05.10» в американской локали читается как 10 мая, а слово понятно в любой.
 * withYear: «5 окт 2026».
 */
export function dayMonth(date: string, withYear = false): string {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${SHORT[Number(m) - 1]}${withYear ? ` ${y}` : ''}`;
}

/** «5 октября 2026, пн»: подпись под полем даты. */
export function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return '';
  const weekday = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${d} ${GENITIVE[m - 1]} ${y}, ${weekday}`;
}

/** Дата ГГГГ-ММ-ДД по часам устройства. toISOString дал бы дату по UTC: в Казахстане до пяти утра это ещё вчера. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function today(): string {
  return ymd(new Date());
}

/**
 * Какая часть плана месяца уже «прожита»: в текущем месяце план входит в фонды по дням (1/30 за первый день),
 * прошедшие месяцы считаются целиком. Только для показа, учёт не меняется.
 */
export function planShare(ym: string): number {
  const now = today();
  if (ym !== now.slice(0, 7)) return ym < now.slice(0, 7) ? 1 : 0;
  const [y, m, d] = now.split('-').map(Number);
  return d / new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Дата по умолчанию для месяца на экране: сегодня, если он текущий, иначе его последний день. */
export function defaultDate(ym: string): string {
  const now = today();
  if (now.startsWith(ym)) return now;
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Около пяти круглых делений оси от min до max. */
export function niceTicks(min: number, max: number): number[] {
  const span = max - min || 1;
  const raw = span / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const ticks = [];
  for (let t = Math.floor(min / step) * step; t <= Math.ceil(max / step) * step + step / 2; t += step) ticks.push(t);
  return ticks;
}

// Эмодзи фондов и участников текущей базы и личные настройки их показа (задаются в LedgerApp, как символ валюты)
let fundEmojis: Record<string, string> = {};
let memberEmojis: Record<string, string> = {};
let showFundEmojis = true;
let showMemberEmojis = true;

export function setEmojis(funds: Record<string, string>, members: Record<string, string>, showFunds: boolean, showMembers: boolean): void {
  fundEmojis = funds;
  memberEmojis = members;
  showFundEmojis = showFunds;
  showMemberEmojis = showMembers;
}

/** Название фонда с эмодзи, если он есть и показ включён. */
export function fundLabel(name: string | null | undefined): string {
  if (!name) return '';
  const emoji = showFundEmojis ? fundEmojis[name] : '';
  return emoji ? `${emoji} ${name}` : name;
}

/** Имя участника с эмодзи, если он есть и показ включён. */
export function memberLabel(name: string | null | undefined): string {
  if (!name) return '';
  const emoji = showMemberEmojis ? memberEmojis[name] : '';
  return emoji ? `${emoji} ${name}` : name;
}
