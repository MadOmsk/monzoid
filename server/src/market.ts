import { all, get, run, tx, type Db } from './db.js';
import { assetValuations, assetValue } from './domain.js';

const TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;
// Если утреннее обновление не удалось, следующая попытка при заходе в приложение, но не чаще раза в 15 минут
const RETRY_MS = 15 * 60_000;
// Сколько дат курсов спрашивать у Нацбанка одновременно при догрузке истории
const RATE_REQUESTS_AT_ONCE = 6;

export interface Quote {
  price: number;
  currency: string;
}

export interface MarketSource {
  rates(): Promise<{ date: string; perUsd: Record<string, number> }>;
  /** null значит, что такого тикера нет. */
  quote(ticker: string): Promise<Quote | null>;
  /** Тенге за единицу валюты на дату; пусто, если на эту дату курсов нет. */
  ratesOn(date: string): Promise<Record<string, number>>;
  /** Цены закрытия акции по месяцам. */
  history(ticker: string): Promise<{ currency: string; closes: Record<string, number> } | null>;
  /** Дневные цены закрытия акции за последний год. */
  daily(ticker: string): Promise<{ currency: string; closes: { date: string; price: number }[] } | null>;
}

export function createMarketSource(): MarketSource {
  return {
    async rates() {
      // Все пары считаются через тенге по курсам Нацбанка РК; сегодняшних курсов утром ещё может не быть
      for (const back of [0, 1, 2, 3]) {
        const date = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
        const kzt = await this.ratesOn(date);
        if (kzt.USD) {
          const perUsd: Record<string, number> = { KZT: kzt.USD };
          for (const [code, value] of Object.entries(kzt)) perUsd[code] = kzt.USD / value;
          return { date, perUsd };
        }
      }
      throw new Error('Нацбанк не отдал курсы');
    },
    async quote(ticker) {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      const data: any = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) {
        if (data?.chart?.error?.code === 'Not Found') return null;
        throw new Error(`Котировка ${ticker} недоступна: ${res.status}`);
      }
      // Лондонская биржа считает в пенсах
      if (meta.currency === 'GBp') return { price: meta.regularMarketPrice / 100, currency: 'GBP' };
      return { price: meta.regularMarketPrice, currency: meta.currency };
    },
    async ratesOn(date) {
      const [y, m, d] = date.split('-');
      const res = await fetch(`https://nationalbank.kz/rss/get_rates.cfm?fdate=${d}.${m}.${y}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Курсы Нацбанка недоступны: ${res.status}`);
      const xml = await res.text();
      const rates: Record<string, number> = {};
      for (const [, code, value, quant] of xml.matchAll(/<title>([A-Z]{3})<\/title>\s*<description>([\d.]+)<\/description>\s*<quant>(\d+)<\/quant>/g)) {
        rates[code] = Number(value) / Number(quant);
      }
      return rates;
    },
    async history(ticker) {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=10y&interval=1mo`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      const result = ((await res.json()) as any)?.chart?.result?.[0];
      if (!result?.timestamp) return null;
      const pence = result.meta.currency === 'GBp';
      const closes: Record<string, number> = {};
      result.timestamp.forEach((t: number, i: number) => {
        const close = result.indicators.quote[0].close[i];
        if (close) closes[new Date(t * 1000).toISOString().slice(0, 7)] = pence ? close / 100 : close;
      });
      return { currency: pence ? 'GBP' : result.meta.currency, closes };
    },
    async daily(ticker) {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      const result = ((await res.json()) as any)?.chart?.result?.[0];
      if (!result?.timestamp) return null;
      const pence = result.meta.currency === 'GBp';
      const closes: { date: string; price: number }[] = [];
      result.timestamp.forEach((t: number, i: number) => {
        const close = result.indicators.quote[0].close[i];
        if (close) closes.push({ date: new Date(t * 1000).toISOString().slice(0, 10), price: pence ? close / 100 : close });
      });
      return { currency: pence ? 'GBP' : result.meta.currency, closes };
    },
  };
}

export function saveQuote(db: Db, ticker: string, quote: Quote, date: string): void {
  run(
    db,
    `INSERT INTO quotes (ticker, price, currency, date) VALUES (?, ?, ?, ?)
     ON CONFLICT (ticker) DO UPDATE SET price = excluded.price, currency = excluded.currency, date = excluded.date`,
    ticker,
    quote.price,
    quote.currency,
    date,
  );
}

/**
 * Утреннее обновление: курсы Нацбанка за день, котировки и дневные цены отслеживаемых акций, цены вкладов за день,
 * затем очередь: дни без курсов с начала учёта. При сбое источника остаются прошлые значения
 * (на экране видно, на какую они дату), а не загруженное догрузится при следующем обновлении.
 */
export async function refreshMarket(db: Db, source: MarketSource, today: string): Promise<boolean> {
  let ok = true;
  try {
    const { date, perUsd } = await source.rates();
    tx(db, () => {
      for (const [currency, rate] of Object.entries(perUsd)) {
        run(db, 'INSERT INTO fx_rates (currency, per_usd, date) VALUES (?, ?, ?) ON CONFLICT (currency) DO UPDATE SET per_usd = excluded.per_usd, date = excluded.date', currency, rate, date);
      }
      // Ежедневное обновление (Нацбанк) идёт и в курсы по датам: формы сделок берут курс на дату из базы
      // и идут в Нацбанк, только если его там нет. Уже загруженные на эту дату курсы не перезаписываются
      if (perUsd.KZT) {
        for (const [currency, rate] of Object.entries(perUsd)) {
          if (rate > 0) run(db, 'INSERT OR IGNORE INTO fx_history (date, currency, kzt_per_unit) VALUES (?, ?, ?)', date, currency, perUsd.KZT / rate);
        }
      }
    });
  } catch (e) {
    console.error('Курсы не обновились:', e);
    ok = false;
  }
  for (const { ticker } of all<{ ticker: string }>(db, 'SELECT DISTINCT ticker FROM pots WHERE ticker IS NOT NULL')) {
    try {
      const quote = await source.quote(ticker);
      if (quote) saveQuote(db, ticker, quote, today);
      if (!(await loadCloses(db, source, ticker))) ok = false;
    } catch (e) {
      console.error(`Котировка ${ticker} не обновилась:`, e);
      ok = false;
    }
  }
  savePotPrices(db, today.slice(0, 7));
  saveDayPrices(db, today);
  await backfillDayPrices(db, source, today);
  await backfillPotPrices(db, source, today);
  if (!(await backfillRates(db, source, today))) ok = false;
  return ok;
}

const updates = new WeakMap<Db, { tried: number; running: Promise<boolean> | null }>();

/** Дата последнего полного обновления курсов и котировок. */
function updatedOn(db: Db): string | null {
  return get<{ value: string }>(db, `SELECT value FROM market_state WHERE key = 'updated'`)?.value ?? null;
}

/**
 * Обновляет курсы и котировки, если сегодня это ещё не удалось. scheduled: утренний запуск, без ограничения
 * частоты; иначе это заход в приложение, и попытка не чаще раза в 15 минут. Пока данные не пришли,
 * везде используются последние сохранённые (вчерашние). Не ждёт окончания.
 */
export function freshenMarket(db: Db, source: MarketSource, scheduled = false): Promise<boolean> | null {
  const today = new Date().toISOString().slice(0, 10);
  if (updatedOn(db) === today) return null;
  const state = updates.get(db) ?? { tried: 0, running: null };
  updates.set(db, state);
  if (state.running) return state.running;
  if (!scheduled && Date.now() - state.tried < RETRY_MS) return null;
  state.tried = Date.now();
  state.running = refreshMarket(db, source, today)
    .then((ok) => {
      if (ok) run(db, `INSERT INTO market_state (key, value) VALUES ('updated', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, today);
      return ok;
    })
    .catch((e) => {
      console.error('Обновление курсов не удалось:', e);
      return false;
    })
    .finally(() => {
      state.running = null;
    });
  return state.running;
}

/**
 * Очередь курсов: каждый день с начала учёта самой ранней базы, где есть валюта или акции, должен быть в fx_history
 * (или в fx_missing, если у Нацбанка на эту дату курсов нет). Один запрос даёт все валюты на дату.
 * Если Нацбанк недоступен, остаток ждёт следующего обновления. false, если загрузилось не всё.
 */
const backfills = new WeakMap<Db, Promise<boolean>>();
export function backfillRates(db: Db, source: MarketSource, today: string): Promise<boolean> {
  const running = backfills.get(db);
  if (running) return running;
  const job = (async () => {
    const start = get<{ ym: string | null }>(
      db,
      `SELECT MIN(l.start_ym) ym FROM ledgers l WHERE EXISTS (SELECT 1 FROM pots p WHERE p.ledger_id = l.id AND p.kind IN ('currency', 'stock'))`,
    )?.ym;
    if (!start) return true;
    const known = new Set([
      ...all<{ date: string }>(db, `SELECT date FROM fx_history WHERE currency = 'KZT' AND date >= ?`, `${start}-01`).map((r) => r.date),
      ...all<{ date: string }>(db, 'SELECT date FROM fx_missing WHERE date >= ?', `${start}-01`).map((r) => r.date),
    ]);
    const missing: string[] = [];
    for (let date = `${start}-01`; date <= today; date = new Date(Date.parse(date) + DAY_MS).toISOString().slice(0, 10)) {
      if (!known.has(date)) missing.push(date);
    }
    for (let i = 0; i < missing.length; i += RATE_REQUESTS_AT_ONCE) {
      const results = await Promise.all(missing.slice(i, i + RATE_REQUESTS_AT_ONCE).map((date) => loadRatesOn(db, source, date, today)));
      // Нацбанк недоступен: остальное подождёт следующего обновления
      if (results.includes('error')) return false;
    }
    return true;
  })().finally(() => backfills.delete(db));
  backfills.set(db, job);
  return job;
}

/** Загружает курсы на дату один раз. Сбой не мешает: вызывающий возьмёт последний известный курс. */
export async function ensureRatesOn(db: Db, source: MarketSource, date: string): Promise<boolean> {
  return (await loadRatesOn(db, source, date, new Date().toISOString().slice(0, 10))) === 'ok';
}

/**
 * Курсы на дату: из базы, а у Нацбанка только если их там нет. Прошлая дата, на которую у Нацбанка курсов нет,
 * запоминается, чтобы не спрашивать снова; сегодняшних курсов может ещё не быть, их спросим позже.
 */
async function loadRatesOn(db: Db, source: MarketSource, date: string, today: string): Promise<'ok' | 'none' | 'error'> {
  if (get(db, `SELECT 1 x FROM fx_history WHERE date = ? AND currency = 'KZT'`, date)) return 'ok';
  if (get(db, 'SELECT 1 x FROM fx_missing WHERE date = ?', date)) return 'none';
  try {
    const rates = await source.ratesOn(date);
    if (!Object.keys(rates).length) {
      if (date < today) run(db, 'INSERT OR IGNORE INTO fx_missing (date) VALUES (?)', date);
      return 'none';
    }
    tx(db, () => {
      for (const [currency, value] of Object.entries({ ...rates, KZT: 1 })) {
        run(db, 'INSERT OR REPLACE INTO fx_history (date, currency, kzt_per_unit) VALUES (?, ?, ?)', date, currency, value);
      }
    });
    return 'ok';
  } catch (e) {
    console.error(`Курсы на ${date} не загрузились:`, e);
    return 'error';
  }
}

/** Курс на дату из загруженных; null, если его нет. */
export function rateOn(db: Db, from: string, to: string, date: string): number | null {
  if (from === to) return 1;
  const value = (currency: string) => get<{ v: number }>(db, 'SELECT kzt_per_unit v FROM fx_history WHERE date = ? AND currency = ?', date, currency)?.v;
  const source = value(from);
  const target = value(to);
  return source && target ? source / target : null;
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function lastDay(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Заполняет настоящими ценами прошлые месяцы без цены. Уже зафиксированные месяцы не меняются. */
export async function backfillPotPrices(db: Db, source: MarketSource, today: string): Promise<void> {
  const currentYm = today.slice(0, 7);
  const pots = all<{ id: number; kind: string; currency: string; ticker: string | null; base: string; start: string }>(
    db,
    `SELECT p.id, p.kind, p.currency, p.ticker, l.currency base, l.start_ym start FROM pots p JOIN ledgers l ON l.id = p.ledger_id WHERE p.kind IN ('currency', 'stock')`,
  );
  for (const pot of pots) {
    const known = new Set(all<{ ym: string }>(db, 'SELECT ym FROM pot_prices WHERE pot_id = ?', pot.id).map((r) => r.ym));
    const missing: string[] = [];
    for (let ym = pot.start; ym < currentYm; ym = nextMonth(ym)) if (!known.has(ym)) missing.push(ym);
    if (!missing.length) continue;
    try {
      const history = pot.ticker ? await source.history(pot.ticker) : null;
      if (pot.ticker && !history) continue;
      for (const ym of missing) {
        const native = history ? history.closes[ym] : 1;
        if (!native) continue;
        const date = lastDay(ym);
        if (!(await ensureRatesOn(db, source, date))) continue;
        const fx = rateOn(db, history?.currency ?? pot.currency, pot.base, date);
        if (fx) run(db, 'INSERT OR IGNORE INTO pot_prices (pot_id, ym, unit_value) VALUES (?, ?, ?)', pot.id, ym, native * fx * 100);
      }
    } catch (e) {
      console.error(`История цен вклада ${pot.id} не загрузилась:`, e);
    }
  }
}

function savePotPrices(db: Db, ym: string): void {
  for (const { id: ledgerId } of all<{ id: number }>(db, 'SELECT id FROM ledgers')) {
    for (const [potId, unit] of potUnitValues(db, ledgerId)) {
      run(db, 'INSERT INTO pot_prices (pot_id, ym, unit_value) VALUES (?, ?, ?) ON CONFLICT (pot_id, ym) DO UPDATE SET unit_value = excluded.unit_value', potId, ym, unit);
    }
  }
}

function saveDayPrices(db: Db, date: string): void {
  for (const { id: ledgerId } of all<{ id: number }>(db, 'SELECT id FROM ledgers')) {
    for (const [potId, unit] of potUnitValues(db, ledgerId)) {
      run(db, 'INSERT INTO pot_day_prices (pot_id, date, unit_value) VALUES (?, ?, ?) ON CONFLICT (pot_id, date) DO UPDATE SET unit_value = excluded.unit_value', potId, date, unit);
    }
  }
}

function dayBefore(date: string): string {
  return new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
}

/** Если у вклада есть только сегодняшняя цена, достаёт вчерашнюю: курс Нацбанка или прошлое закрытие акции. */
async function backfillDayPrices(db: Db, source: MarketSource, today: string): Promise<void> {
  const pots = all<{ id: number; currency: string; ticker: string | null; base: string }>(
    db,
    `SELECT p.id, p.currency, p.ticker, l.currency base FROM pots p JOIN ledgers l ON l.id = p.ledger_id
     WHERE p.kind IN ('currency', 'stock') AND NOT EXISTS (SELECT 1 FROM pot_day_prices d WHERE d.pot_id = p.id AND d.date < ?)`,
    today,
  );
  for (const pot of pots) {
    try {
      let date = dayBefore(today);
      let native = 1;
      let currency = pot.currency;
      if (pot.ticker) {
        const daily = await dailyOf(db, source, pot.ticker);
        const close = daily?.closes.filter((c) => c.date < today).at(-1);
        if (!daily || !close) continue;
        ({ date, price: native } = close);
        currency = daily.currency;
      }
      if (!(await ensureRatesOn(db, source, date))) continue;
      const fx = rateOn(db, currency, pot.base, date);
      if (fx) run(db, 'INSERT OR IGNORE INTO pot_day_prices (pot_id, date, unit_value) VALUES (?, ?, ?)', pot.id, date, native * fx * 100);
    } catch (e) {
      console.error(`Вчерашняя цена вклада ${pot.id} не загрузилась:`, e);
    }
  }
}

/** Изменение стоимости вклада между двумя последними днями с ценой, по текущему количеству. */
function dayGain(db: Db, potId: number, units: number): { gain: number; since: string } | null {
  const [last, prev] = all<{ date: string; unit: number }>(db, 'SELECT date, unit_value unit FROM pot_day_prices WHERE pot_id = ? ORDER BY date DESC LIMIT 2', potId);
  if (!last || !prev) return null;
  return { gain: Math.round(units * (last.unit - prev.unit)), since: prev.date };
}

/** Зафиксированные цены вкладов базы по месяцам, по возрастанию месяца. */
export function potPriceHistory(db: Db, ledgerId: number) {
  return all<{ potId: number; ym: string; unit: number }>(
    db,
    `SELECT pp.pot_id potId, pp.ym, pp.unit_value unit FROM pot_prices pp JOIN pots p ON p.id = pp.pot_id WHERE p.ledger_id = ? ORDER BY pp.ym`,
    ledgerId,
  );
}

/**
 * Обновляет курсы и котировки каждый день в 05:00 по Астане (полночь UTC) и при запуске, если сегодня ещё не обновляли.
 * Если не удалось, следующая попытка при заходе в приложение (freshenMarket) или в 05:00 следующего дня.
 */
export function startMarketUpdates(db: Db, source: MarketSource): void {
  void freshenMarket(db, source, true);
  const schedule = () => {
    const now = Date.now();
    const next = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
    setTimeout(() => {
      void freshenMarket(db, source, true);
      schedule();
    }, next - now + 1000).unref();
  };
  schedule();
}

function rate(db: Db, currency: string): { perUsd: number; date: string } | null {
  const row = get<{ per_usd: number; date: string }>(db, 'SELECT per_usd, date FROM fx_rates WHERE currency = ?', currency);
  return row ? { perUsd: row.per_usd, date: row.date } : null;
}

/** Переводит сумму по последнему курсу; null, если курса нет. */
export function convert(db: Db, amount: number, from: string, to: string): { amount: number; rate: number; date: string } | null {
  if (from === to) return { amount, rate: 1, date: '' };
  const source = rate(db, from);
  const target = rate(db, to);
  if (!source || !target) return null;
  const value = target.perUsd / source.perUsd;
  return { amount: Math.round(amount * value), rate: value, date: target.date };
}

export interface PotValue {
  id: number;
  name: string;
  kind: 'cash' | 'currency' | 'stock' | 'asset';
  currency: string;
  ticker: string | null;
  /** Сколько вложено в основной валюте базы */
  balance: number;
  /** Единицы валюты или число акций */
  units: number;
  /** Что было на старте базы: вложено в основной валюте и количество */
  openingBalance: number;
  openingUnits: number;
  /** Цена единицы: котировка акции или курс валюты */
  price: number | null;
  /** Оценка в основной валюте; null, если нет курса */
  value: number | null;
  rateDate: string | null;
  /** Дата последней оценки актива; null, если актив считается по уплаченной сумме */
  valuedAt?: string | null;
  /** Изменение цены за последний день с котировкой; null, если двух дней ещё нет */
  day?: { gain: number; since: string } | null;
}

interface UnitPrice {
  /** Цена единицы в сотых долях основной валюты */
  unit: number;
  /** Цена для показа: котировка в валюте акции или курс валюты */
  shown: number;
  currency: string;
  date: string;
}

function unitPrice(db: Db, pot: { kind: string; currency: string; ticker: string | null }, base: string): UnitPrice | null {
  // Деньги в основной валюте и активы считаются не по курсу
  if (pot.kind === 'cash' || pot.kind === 'asset') return null;
  const quote = pot.ticker ? get<{ price: number; currency: string; date: string }>(db, 'SELECT price, currency, date FROM quotes WHERE ticker = ?', pot.ticker) : null;
  if (pot.ticker && !quote) return null;
  const currency = quote?.currency ?? pot.currency;
  const fx = convert(db, 1, currency, base);
  if (!fx) return null;
  const native = quote?.price ?? 1;
  return { unit: native * fx.rate * 100, shown: quote?.price ?? fx.rate, currency, date: quote?.date ?? fx.date };
}

/** Стоимость одной единицы каждого вклада в основной валюте. Нет в списке: считается по вложенной сумме. */
export function potUnitValues(db: Db, ledgerId: number): Map<number, number> {
  const base = get<{ currency: string }>(db, 'SELECT currency FROM ledgers WHERE id = ?', ledgerId)!.currency;
  const result = new Map<number, number>();
  for (const pot of all<{ id: number; kind: string; currency: string; ticker: string | null }>(db, 'SELECT id, kind, currency, ticker FROM pots WHERE ledger_id = ?', ledgerId)) {
    const price = unitPrice(db, pot, base);
    if (price) result.set(pot.id, price.unit);
  }
  return result;
}

/** Стоимость вкладов по последним курсам и котировкам. Без количества вклад считается по вложенной сумме. */
export function valuePots(db: Db, ledgerId: number): PotValue[] {
  const base = get<{ currency: string }>(db, 'SELECT currency FROM ledgers WHERE id = ?', ledgerId)!.currency;
  const pots = all<Omit<PotValue, 'price' | 'value' | 'rateDate'> & { counted: number }>(
    db,
    `SELECT p.id, p.name, p.kind, p.currency, p.ticker, p.opening_balance openingBalance, p.opening_units openingUnits,
       p.opening_balance + COALESCE((SELECT SUM(m.amount) FROM pot_moves m WHERE m.pot_id = p.id AND m.inactive_at IS NULL), 0) balance,
       p.opening_units + COALESCE((SELECT SUM(m.units) FROM pot_moves m WHERE m.pot_id = p.id AND m.inactive_at IS NULL), 0) units,
       p.opening_units != 0 OR EXISTS (SELECT 1 FROM pot_moves m WHERE m.pot_id = p.id AND m.units != 0 AND m.inactive_at IS NULL) counted
     FROM pots p WHERE p.ledger_id = ? ORDER BY p.id`,
    ledgerId,
  );
  const valuations = assetValuations(db, ledgerId);
  return pots.map(({ counted, ...pot }) => {
    if (pot.kind === 'asset') {
      const last = valuations.filter((v) => v.potId === pot.id).at(-1);
      const value = assetValue({ invested: pot.balance, units: pot.units, counted: !!counted }, last?.value);
      return { ...pot, price: null, value, rateDate: null, valuedAt: pot.units > 0 && last ? last.date : null };
    }
    // Проданная до нуля валюта или акция стоит 0: разница покупки и продажи уже доход или убыток
    if (pot.kind !== 'cash' && pot.units === 0 && counted) return { ...pot, price: null, value: 0, rateDate: null };
    if (pot.kind === 'cash' || pot.units === 0) return { ...pot, price: null, value: pot.balance, rateDate: null };
    const price = unitPrice(db, pot, base);
    if (!price) return { ...pot, price: null, value: null, rateDate: null };
    return { ...pot, currency: price.currency, price: price.shown, value: Math.round(pot.units * price.unit), rateDate: price.date, day: dayGain(db, pot.id, pot.units) };
  });
}

// Курсы валют для графика вклада: по неделям за два года
const QUOTE_WEEKS = 104;

export interface PotQuotes {
  /** Валюта цены: котировки акции или основная валюта базы для курса */
  currency: string;
  points: { date: string; price: number }[];
  /** Покупки и продажи; цена единицы в той же валюте, null без количества или курса */
  moves: { id: number; date: string; amount: number; units: number; comment: string; toPotId: number | null; linked: boolean; pairPotId: number | null; salePotId: number | null; price: number | null }[];
}

/** Загружает дневные цены закрытия акции за год в базу. false, если источник недоступен или тикера нет. */
async function loadCloses(db: Db, source: MarketSource, ticker: string): Promise<boolean> {
  try {
    const data = await source.daily(ticker);
    if (!data) return false;
    tx(db, () => {
      for (const c of data.closes) {
        run(db, 'INSERT OR REPLACE INTO stock_closes (ticker, date, price, currency) VALUES (?, ?, ?, ?)', ticker, c.date, c.price, data.currency);
      }
    });
    return true;
  } catch (e) {
    console.error(`Дневные цены ${ticker} не загрузились:`, e);
    return false;
  }
}

/** Дневные цены акции из базы; у источника только если их там ещё нет (новый тикер). */
async function dailyOf(db: Db, source: MarketSource, ticker: string): ReturnType<MarketSource['daily']> {
  const read = () => all<{ date: string; price: number; currency: string }>(db, 'SELECT date, price, currency FROM stock_closes WHERE ticker = ? ORDER BY date', ticker);
  let rows = read();
  if (!rows.length && (await loadCloses(db, source, ticker))) rows = read();
  if (!rows.length) return null;
  return { currency: rows[0].currency, closes: rows.map(({ date, price }) => ({ date, price })) };
}

/** Цена акции на дату: последнее закрытие не позже даты, а без истории котировка из базы. null, если тикера нет. */
export async function stockPriceOn(db: Db, source: MarketSource, ticker: string, date: string, today: string): Promise<(Quote & { date: string }) | null> {
  const data = await dailyOf(db, source, ticker);
  const close = data?.closes.filter((c) => c.date <= date).at(-1);
  if (data && close) return { price: close.price, currency: data.currency, date: close.date };
  const saved = get<{ price: number; currency: string; date: string }>(db, 'SELECT price, currency, date FROM quotes WHERE ticker = ?', ticker);
  if (saved) return saved;
  const quote = await source.quote(ticker);
  if (quote) saveQuote(db, ticker, quote, today);
  return quote && { ...quote, date: today };
}

/** Котировка акции по дням или курс валюты по неделям за два года, с покупками для сравнения. */
export async function potQuotes(db: Db, source: MarketSource, potId: number, today: string): Promise<PotQuotes> {
  const pot = get<{ kind: string; currency: string; ticker: string | null; base: string }>(
    db,
    'SELECT p.kind, p.currency, p.ticker, l.currency base FROM pots p JOIN ledgers l ON l.id = p.ledger_id WHERE p.id = ?',
    potId,
  )!;
  let currency = pot.base;
  let points: PotQuotes['points'] = [];
  if (pot.ticker) {
    const data = await dailyOf(db, source, pot.ticker);
    currency = data?.currency ?? pot.currency;
    points = data?.closes ?? [];
  } else if (pot.kind === 'currency') {
    const dates = Array.from({ length: QUOTE_WEEKS + 1 }, (_, i) => new Date(Date.parse(today) - (QUOTE_WEEKS - i) * 7 * 86_400_000).toISOString().slice(0, 10));
    for (let i = 0; i < dates.length; i += RATE_REQUESTS_AT_ONCE) {
      await Promise.all(dates.slice(i, i + RATE_REQUESTS_AT_ONCE).map((date) => ensureRatesOn(db, source, date)));
    }
    points = dates.flatMap((date) => {
      const price = rateOn(db, pot.currency, pot.base, date);
      return price ? [{ date, price }] : [];
    });
  }
  const moves: PotQuotes['moves'] = [];
  // toPotId: продажа актива положила деньги в этот вклад; linked: запись следует за продажей и руками не правится
  // pairPotId: вклад на другой стороне перевода между вкладами
  // salePotId: актив, за продажей которого следует запись (её меняют в карточке актива)
  for (const move of all<{ id: number; date: string; amount: number; units: number; comment: string; toPotId: number | null; linked: number; pairPotId: number | null; salePotId: number | null }>(
    db,
    `SELECT m.id, m.date, m.amount, m.units, m.comment, m.to_pot_id toPotId, (m.sale_move_id IS NOT NULL OR m.entry_id IS NOT NULL) linked, p.pot_id pairPotId, s.pot_id salePotId
     FROM pot_moves m LEFT JOIN pot_moves p ON p.id = m.pair_id LEFT JOIN pot_moves s ON s.id = m.sale_move_id
     WHERE m.pot_id = ? AND m.inactive_at IS NULL ORDER BY m.date, m.id`,
    potId,
  )) {
    let price: number | null = null;
    if (move.units) {
      const fx = currency === pot.base ? 1 : (await ensureRatesOn(db, source, move.date)) ? rateOn(db, currency, pot.base, move.date) : null;
      if (fx) price = move.amount / 100 / move.units / fx;
    }
    moves.push({ ...move, linked: !!move.linked, price });
  }
  return { currency, points, moves };
}
