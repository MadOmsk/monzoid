import { useEffect, useState } from 'react';
import { api, ApiError, confirmAction, useLoad, withRecalc, type AssetValue, type MarketPrice, type MonthReport, type Pot, type PotQuotes } from './api';
import { useBack } from './back';
import { numberInput, amount, dayMonth, fundLabel, moneyRounded as money, monthShort, niceTicks, shiftYm, parseMoney, parseUnits, signedRounded as signed, symbol, today, toGroupedInput, toInput, tone } from './format';
import { Banner, Button, DateInput, Header, Segmented, Spinner, useRemembered } from './ui';

const FOREIGN_CURRENCIES = ['USD', 'EUR', 'RUB', 'GBP', 'CNY', 'TRY', 'AED', 'KZT', 'KGS', 'UZS'];

const KIND_TITLES: [Pot['kind'], string][] = [['currency', 'Валюта'], ['stock', 'Акции'], ['asset', 'Активы'], ['cash', 'Деньги в основной валюте']];

function shortDate(date: string): string {
  return dayMonth(date, true);
}

type Period = '1m' | '3m' | '6m' | '1y' | '2y';
const PERIOD_DAYS: Record<Period, number> = { '1m': 31, '3m': 92, '6m': 183, '1y': 366, '2y': 731 };

function percent(ratio: number): string {
  const text = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(ratio * 100).replace('-', '−');
  return `${ratio > 0 ? '+' : ''}${text}%`;
}

function potFacts(p: Pot): string {
  if (p.kind === 'stock') return `${p.ticker} · ${amount(p.units, 4)} шт.${p.price !== null ? ` · ${amount(p.price)} ${symbol(p.currency)}` : ''}`;
  if (p.kind === 'currency') return `${amount(p.units)} ${symbol(p.currency)}${p.price !== null ? ` · курс ${amount(p.price)}` : ''}`;
  if (p.kind === 'asset') return p.units <= 0 ? 'Продан' : p.valuedAt ? `Оценка на ${shortDate(p.valuedAt)}` : 'По уплаченной сумме';
  return 'В основной валюте';
}

/** Вложено и стоимость по вкладам с известной оценкой. */
function totals(pots: Pot[]) {
  const valued = pots.filter((p) => p.value !== null);
  const invested = valued.reduce((sum, p) => sum + p.balance, 0);
  const value = valued.reduce((sum, p) => sum + p.value!, 0);
  return { invested, value, gain: value - invested, ratio: invested > 0 ? (value - invested) / invested : 0 };
}

function Gain({ gain, ratio }: { gain: number; ratio: number }) {
  if (gain === 0) return <span>0</span>;
  return <span className={tone(gain)}>{signed(gain)} · {percent(ratio)}</span>;
}

/** Подвкладка вкладов: валюта, акции или активы (вместе с деньгами в основной валюте, например от сделок). */
type Tab = 'currency' | 'stock' | 'asset';
const TABS: [Tab, string][] = [['currency', 'Валюта'], ['stock', 'Акции'], ['asset', 'Активы']];
const tabOf = (kind: Pot['kind']): Tab => (kind === 'cash' ? 'asset' : kind);
/** Стоимость и вложенное подвкладки на конец месяца из отчёта */
function monthSlice(m: MonthReport, tab: Tab) {
  if (tab === 'currency') return { value: m.currencyAfter, invested: m.currencyInvested };
  if (tab === 'stock') return { value: m.stocksAfter, invested: m.stocksInvested };
  // Деньги в основной валюте стоят столько, сколько вложено
  return { value: m.assetsAfter + m.cashInvested, invested: m.assetsInvested + m.cashInvested };
}

/**
 * Изменение стоимости за период без учёта довнесений и выводов: сегодняшняя стоимость против конца месяца
 * N месяцев назад, минус то, что за это время вложили. Купленное внутри периода считается от цены покупки,
 * а не от курса начала периода. Месяц берётся по закрытым отчётам, поэтому «Месяц» это с конца прошлого месяца.
 */
function periodGains(months: MonthReport[], now: { value: number; invested: number }, current: string | undefined, tab: Tab) {
  if (!current) return [];
  return ([['Месяц', 1], ['Полгода', 6], ['Год', 12]] as const).flatMap(([label, back]) => {
    const then = months.find((m) => m.ym === shiftYm(current, -back));
    if (!then) return [];
    const was = monthSlice(then, tab);
    const added = now.invested - was.invested;
    const gain = now.value - was.value - added;
    // Процент от денег, которые работали в периоде: стоимость в начале плюс докупленное, иначе мелкий старт раздувает процент
    const base = was.value + Math.max(0, added);
    return [{ label, since: `конца ${monthShort(then.ym)}`, gain, ratio: base > 0 ? gain / base : null }];
  });
}

function dayLabel(date: string): string {
  return dayMonth(date);
}

/** Вкладка «Вклады» в нижней панели. Доход за месяцы считается по закрытым месяцам, как в статистике. */
export function PotsScreen({ base, isAdmin, currency, currentYm }: { base: string; isAdmin: boolean; currency: string; currentYm: string }) {
  const { data, error } = useLoad<{ months: MonthReport[] }>(`${base}/history`);
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) return <Spinner />;
  return (
    <>
      <h1>Вклады и активы</h1>
      <PotsView base={base} isAdmin={isAdmin} currency={currency} months={data.months.filter((m) => m.closed)} currentYm={currentYm} />
    </>
  );
}

/** Вклады: доходность всего, по группам и по каждому вкладу. */
function PotsView({ base, isAdmin, currency, months = [], currentYm }: { base: string; isAdmin: boolean; currency: string; months?: MonthReport[]; currentYm?: string }) {
  const { data, error, reload } = useLoad<Pot[]>(`${base}/pots`);
  const [openId, setOpenId] = useState<number | null>(null);
  const [showSold, setShowSold] = useState(false);
  const [tab, setTab] = useRemembered<Tab>(`${base}:potsTab`, 'currency');
  useBack(openId !== null, 2, () => setOpenId(null));

  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) return <Spinner />;
  const open = data.find((p) => p.id === openId);
  if (open?.kind === 'asset') return <AssetDetail base={base} pot={open} isAdmin={isAdmin} onChanged={reload} onBack={() => setOpenId(null)} />;
  if (open) return <PotDetail base={base} pot={open} isAdmin={isAdmin} onChanged={reload} onBack={() => setOpenId(null)} />;

  const present = TABS.filter(([t]) => data.some((p) => tabOf(p.kind) === t));
  const current = present.some(([t]) => t === tab) ? tab : present[0]?.[0] ?? 'currency';
  const shown = data.filter((p) => tabOf(p.kind) === current);
  // У проданных активов стоимость 0; они не мешают итогу, но и не входят в «вложено» как действующие
  const sum = totals(shown);
  // За день: только вклады с котировкой за два дня; дата самая ранняя из них
  const days = shown.flatMap((p) => (p.day ? [p.day] : []));
  const day = days.length ? { gain: days.reduce((s, d) => s + d.gain, 0), since: days.map((d) => d.since).sort()[0] } : null;
  const dates = [...new Set(shown.flatMap((p) => (p.rateDate ? [p.rateDate] : [])))].sort();
  const valueTitle = current === 'currency' ? 'Стоимость валюты' : current === 'stock' ? 'Стоимость акций' : 'Стоимость активов';
  return (
    <>
      {data.length === 0 && <p className="muted">Вкладов пока нет. Их можно завести ниже: валюту, акции, деньги в основной валюте или активы вроде квартиры и машины.</p>}
      {present.length > 1 && <Segmented<Tab> value={current} options={present} onChange={setTab} />}
      {shown.length > 0 && (
        <div className="tiles">
          <div className="tile full">
            <span>{valueTitle}</span>
            <strong>{money(sum.value)}</strong>
            <small>{current === 'asset' ? 'уплачено' : 'вложено'} {money(sum.invested)}</small>
          </div>
          <div className="tile full">
            <span>{current === 'asset' ? 'Изменение оценки' : 'Доход'}</span>
            <dl className="period-gains">
              {day && (
                <div>
                  <dt>День <span className="muted">с {dayLabel(day.since)}</span></dt>
                  <dd className={tone(day.gain)}>{signed(day.gain)}{sum.value - day.gain > 0 && <span className="muted"> · {percent(day.gain / (sum.value - day.gain))}</span>}</dd>
                </div>
              )}
              {periodGains(months, sum, currentYm, current).map((g) => (
                <div key={g.label}>
                  <dt>{g.label} <span className="muted">с {g.since}</span></dt>
                  <dd className={tone(g.gain)}>{signed(g.gain)}{g.ratio !== null && <span className="muted"> · {percent(g.ratio)}</span>}</dd>
                </div>
              ))}
              <div>
                <dt>Всё время <span className="muted">к вложенному</span></dt>
                <dd className={tone(sum.gain)}>{signed(sum.gain)}{sum.invested > 0 && <span className="muted"> · {percent(sum.ratio)}</span>}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}
      {KIND_TITLES.filter(([kind]) => tabOf(kind) === current).map(([kind, title]) => {
        const all = data.filter((p) => p.kind === kind);
        // Проданные активы стоят 0 и только мешают; их можно показать кнопкой
        const sold = kind === 'asset' ? all.filter((p) => p.units <= 0) : [];
        const group = showSold ? all : all.filter((p) => !sold.includes(p));
        if (!all.length) return null;
        const sum = totals(group);
        return (
          <section key={kind} className="pot-group">
            {current === 'asset' && <div className="fund-top"><h2>{title}</h2><b>{money(sum.value)}</b></div>}
            {kind === 'asset' && <small className="muted pot-group-sum">Покупка и продажа не входят в доходы и расходы, стоимость задаётся оценкой</small>}

            <ul className="tag-rank">
              {group.map((p) => {
                const gain = p.value !== null ? p.value - p.balance : 0;
                return (
                  <li key={p.id}>
                    <button type="button" onClick={() => { setOpenId(p.id); window.scrollTo(0, 0); }}>
                      <div className="fund-top"><span className="entry-title">{p.name}</span><b>{p.value !== null ? money(p.value) : 'нет курса'}</b></div>
                      <div className="fund-bottom muted">
                        <span>{potFacts(p)}</span>
                        {p.kind === 'asset' && p.units > 0 && <span>уплачено {money(p.balance)}</span>}
                        {p.kind !== 'cash' && p.kind !== 'asset' && <span>вложено {money(p.balance)}{p.balance > 0 && <> · <Gain gain={gain} ratio={gain / p.balance} /></>}</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            {sold.length > 0 && (
              <button type="button" className="link" onClick={() => setShowSold(!showSold)}>
                {showSold ? 'Скрыть проданные' : `Показать проданные: ${sold.length}`}
              </button>
            )}
          </section>
        );
      })}
      {dates.length > 0 && <p className="muted small">Курсы и котировки обновляются раз в день, данные на {dates.map((d) => dayMonth(d)).join(', ')}. Курсы: Нацбанк РК, котировки: Yahoo Finance. Нажми на вклад, чтобы посмотреть котировки за год.</p>}
      {isAdmin && <StockTrade base={base} pots={data} onChanged={reload} />}
      {isAdmin && <PotsManager base={base} pots={data} baseCurrency={currency} onChanged={reload} />}
    </>
  );
}

function PotDetail({ base, pot, isAdmin, onChanged, onBack }: { base: string; pot: Pot; isAdmin: boolean; onChanged: () => Promise<void>; onBack: () => void }) {
  // У вклада в основной валюте котировок нет, но сделки приходят тем же запросом
  const { data, error, reload } = useLoad<PotQuotes>(`${base}/pots/${pot.id}/quotes`);
  const [period, setPeriod] = useState<Period>('1y');
  const gain = pot.value !== null ? pot.value - pot.balance : 0;

  const from = new Date(Date.now() - PERIOD_DAYS[period] * 86_400_000).toISOString().slice(0, 10);
  const points = data?.points.filter((p) => p.date >= from) ?? [];
  const buys = data?.moves.filter((m) => m.units > 0 && m.price !== null) ?? [];
  const boughtUnits = buys.reduce((sum, m) => sum + m.units, 0);
  const average = boughtUnits ? buys.reduce((sum, m) => sum + m.price! * m.units, 0) / boughtUnits : null;
  const first = points[0];
  const last = points[points.length - 1];
  const unit = data ? symbol(data.currency) : '';

  return (
    <>
      <Header title={pot.name} onBack={onBack} />
      <p className="muted small">{potFacts(pot)}</p>
      {isAdmin && <RenamePot base={base} pot={pot} onChanged={onChanged} />}
      {isAdmin && <OpeningEditor base={base} pot={pot} onChanged={async () => { await Promise.all([reload(), onChanged()]); }} />}
      <div className="tiles">
        <div className="tile"><span>Стоимость</span><strong>{pot.value !== null ? money(pot.value) : 'нет курса'}</strong><small>вложено {money(pot.balance)}</small></div>
        <div className="tile">
          <span>Доход</span>
          <strong className={tone(gain)}>{signed(gain)}</strong>
          {pot.balance > 0 && <small>{percent(gain / pot.balance)} к вложенному</small>}
        </div>
        {average !== null && last && (
          <div className="tile full">
            <span>Средняя цена покупки</span>
            <strong>{amount(average)} {unit}</strong>
            <small>сейчас {amount(last.price)} {unit} · <span className={tone(last.price - average)}>{percent(last.price / average - 1)}</span></small>
          </div>
        )}
      </div>

      {pot.kind !== 'cash' && (
        <>
          <h2>{pot.kind === 'stock' ? `Котировка, ${unit}` : `Курс ${pot.currency}, ${unit}`}</h2>
          <Segmented value={period} options={[['1m', 'Месяц'], ['3m', '3 мес'], ['6m', 'Полгода'], ['1y', 'Год'], ['2y', '2 года']]} onChange={setPeriod} />
          {error && <Banner kind="error">{error}</Banner>}
          {!data && !error && <Spinner />}
          {data && points.length < 2 && <p className="muted">Котировок за этот период нет.</p>}
          {data && points.length >= 2 && (
            <>
              <p className="small">
                За период: <span className={tone(last.price - first.price)}>{percent(last.price / first.price - 1)}</span>
                <span className="muted"> · {amount(first.price)} → {amount(last.price)} {unit}</span>
              </p>
              <PriceChart points={points} buys={data.moves.filter((m) => m.price !== null && m.date >= from && m.units !== 0)} average={average} unit={unit} period={period} />
            </>
          )}
        </>
      )}

      {data && (
        <>
          <h2>{pot.kind === 'cash' ? 'Переводы' : 'Покупки и продажи'}</h2>
          {isAdmin && (pot.kind === 'stock' && pot.ticker
            ? <StockTrade base={base} pots={[pot]} fixed={pot} onChanged={async () => { await Promise.all([reload(), onChanged()]); }} />
            : <PotMove base={base} pot={pot} onChanged={async () => { await Promise.all([reload(), onChanged()]); }} />)}
          <Deals base={base} pot={pot} moves={data.moves} unit={unit} isAdmin={isAdmin} onChanged={async () => { await Promise.all([reload(), onChanged()]); }} />
        </>
      )}
    </>
  );
}

interface AssetExpense {
  id: number;
  date: string;
  amount: number;
  comment: string;
  description: string;
  fundName: string | null;
}

/** Актив: стоимость по последней оценке, история оценок, сопутствующие расходы и сделки. */
function AssetDetail({ base, pot, isAdmin, onChanged, onBack }: { base: string; pot: Pot; isAdmin: boolean; onChanged: () => Promise<void>; onBack: () => void }) {
  const values = useLoad<AssetValue[]>(`${base}/pots/${pot.id}/values`);
  const deals = useLoad<PotQuotes>(`${base}/pots/${pot.id}/quotes`);
  const expenses = useLoad<AssetExpense[]>(`${base}/pots/${pot.id}/expenses`);
  const expensesTotal = (expenses.data ?? []).reduce((s, e) => s + e.amount, 0);
  const dealsChanged = async () => { await Promise.all([deals.reload(), values.reload(), onChanged()]); };
  const [date, setDate] = useState(today());
  const [value, setValue] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const owned = pot.units > 0;

  async function changed() {
    setError(null);
    await Promise.all([values.reload(), onChanged()]);
  }

  async function add() {
    const sum = parseMoney(value);
    if (sum === null || sum < 0) return setError('Проверь стоимость.');
    try {
      if ((await withRecalc((recalc) => api.post(`${base}/pots/${pot.id}/values`, { date, value: sum, comment, recalc }))) === null) return;
      setValue('');
      setComment('');
      await changed();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(v: AssetValue) {
    if (!(await confirmAction(`Убрать оценку ${money(v.value)} на ${shortDate(v.date)}? Стоимость вернётся к предыдущей оценке.`))) return;
    try {
      if ((await withRecalc((recalc) => api.del(`${base}/pots/${pot.id}/values/${v.id}${recalc ? '?recalc=1' : ''}`))) === null) return;
      await changed();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Header title={pot.name} onBack={onBack} />
      <p className="muted small">{potFacts(pot)}</p>
      {isAdmin && <RenamePot base={base} pot={pot} onChanged={onChanged} />}
      <div className="tiles">
        <div className="tile"><span>Стоимость</span><strong>{money(pot.value ?? 0)}</strong>{owned && <small>{pot.valuedAt ? `оценка на ${shortDate(pot.valuedAt)}` : 'оценки ещё нет'}</small>}</div>
        <div className="tile"><span>{owned ? 'Уплачено' : 'Итог сделок'}</span><strong>{money(owned ? pot.balance : -pot.balance)}</strong><small>{owned ? 'покупка и вложения' : 'продажа минус покупка'}</small></div>
      </div>
      {error && <Banner kind="error">{error}</Banner>}

      {!!expenses.data?.length && (
        <>
          <h2>Сопутствующие расходы</h2>
          <p className="muted small">Расходы, внесённые с фондом «Актив»: списываются из свободных, на стоимость актива не влияют.</p>
          <ul className="tag-rank">
            {expenses.data.map((e) => (
              <li key={e.id}>
                <div className="static">
                  <div className="fund-top"><span className="entry-title">{e.comment || e.description || 'без комментария'}</span><b>{money(e.amount)}</b></div>
                  <div className="fund-bottom muted small"><span>{shortDate(e.date)}{e.fundName ? ` · ${fundLabel(e.fundName)}` : ' · из свободных'}</span></div>
                </div>
              </li>
            ))}
          </ul>
          <dl className="facts">
            <div><dt>Сопутствующие расходы</dt><dd>{money(expensesTotal)}</dd></div>
            {owned && <div><dt>Уплачено с расходами</dt><dd><b>{money(pot.balance + expensesTotal)}</b></dd></div>}
          </dl>
        </>
      )}

      <h2>Оценки</h2>
      <p className="muted small">Стоимость в месяце берётся из последней оценки на его конец, до первой оценки актив стоит столько, сколько за него заплатили. Новая оценка не стирает старые.</p>
      {values.error && <Banner kind="error">{values.error}</Banner>}
      {!values.data && !values.error && <Spinner />}
      {values.data?.length === 0 && <p className="muted">Оценок пока нет.</p>}
      {!!values.data?.length && (
        <ul className="tag-rank">
          {values.data.map((v) => (
            <li key={v.id}>
              <div className="static">
                <div className="fund-top"><span className="entry-title">{shortDate(v.date)}</span><b>{money(v.value)}</b></div>
                <div className="fund-bottom muted small">
                  <span>{v.comment || 'без комментария'}{v.userName && ` · ${v.userName}`}</span>
                  {isAdmin && <button type="button" className="link" onClick={() => remove(v)}>Убрать</button>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {isAdmin && owned && (
        <details className="section">
          <summary>Новая оценка</summary>
          <div className="section-body">
            <div className="inline-form wrap">
              <input aria-label="Стоимость" inputMode="text" placeholder={`Стоимость, ${symbol()}`} value={value} onChange={(e) => setValue(numberInput(e.target.value))} />
              <DateInput label="Дата оценки" value={date} max={today()} onChange={setDate} />
              <input aria-label="Комментарий" placeholder="Откуда оценка" value={comment} onChange={(e) => setComment(e.target.value)} />
              <Button small onClick={add}>Сохранить</Button>
            </div>
          </div>
        </details>
      )}

      <h2>Сделки</h2>
      {isAdmin && <PotMove base={base} pot={pot} onChanged={dealsChanged} />}
      {isAdmin && <OpeningEditor base={base} pot={pot} onChanged={dealsChanged} />}
      {deals.error && <Banner kind="error">{deals.error}</Banner>}
      {deals.data?.moves.length === 0 && <p className="muted">Сделок нет: актив был до начала учёта.</p>}
      {!!deals.data?.moves.length && <Deals base={base} pot={pot} moves={deals.data.moves} unit={symbol()} isAdmin={isAdmin} onChanged={dealsChanged} />}
    </>
  );
}

/** Форма сделки: своим раскрывающимся разделом в карточке или телом внутри общего раздела. */
function Section({ title, inline, children }: { title: string; inline?: boolean; children: React.ReactNode }) {
  if (inline) return <div className="stack">{children}</div>;
  return (
    <details className="section">
      <summary>{title}</summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

/** Число для поля ввода: до digits знаков после запятой, без лишних нулей. */
function decimalInput(value: number, digits: number): string {
  return String(Number(value.toFixed(digits))).replace('.', ',');
}

/** Покупка и продажа прямо в карточке вклада (валюта, вклад в основной валюте, актив). */
function PotMove({ base, pot, inline, onChanged }: { base: string; pot: Pot; inline?: boolean; onChanged: () => Promise<void> }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [sum, setSum] = useState('');
  const [units, setUnits] = useState('');
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Какие поля человек ввёл сам; второе считается по курсу на дату, пока его не поправили руками
  const [manual, setManual] = useState({ sum: false, units: false });
  const asset = pot.kind === 'asset';
  const counted = pot.kind === 'currency';
  const owned = pot.units > 0;
  const quote = useLoad<MarketPrice>(counted ? `${base}/market/price?date=${date}&currency=${pot.currency}` : null);
  const perUnit = quote.data ? quote.data.price * quote.data.rate : null;
  const derive = (from: 'sum' | 'units', text: string, per: number | null) => {
    if (!per) return;
    if (from === 'sum') {
      const value = parseMoney(text);
      setUnits(value && value > 0 ? decimalInput(value / 100 / per, 2) : '');
    } else {
      const count = parseUnits(text);
      setSum(count && count > 0 ? toGroupedInput(Math.round(count * per * 100)) : '');
    }
  };
  const type = (field: 'sum' | 'units', text: string) => {
    if (field === 'sum') setSum(text);
    else setUnits(text);
    const other = field === 'sum' ? 'units' : 'sum';
    const next = { ...manual, [field]: text.trim() !== '' };
    setManual(next);
    if (!manual[other]) derive(field, text, perUnit);
  };
  // Новая дата или пришёл курс: пересчитать то, что не вводили руками
  useEffect(() => {
    if (manual.sum && !manual.units) derive('sum', sum, perUnit);
    if (manual.units && !manual.sum) derive('units', units, perUnit);
  }, [perUnit]);
  const words = asset
    ? { buy: owned ? 'Вложение' : 'Покупка', sell: 'Продажа' }
    : pot.kind === 'cash' ? { buy: 'Положить', sell: 'Забрать' } : { buy: 'Купить', sell: 'Продать' };

  async function save() {
    const value = parseMoney(sum);
    if (!value || value <= 0) return setError(`Укажи сумму в ${symbol()}.`);
    const count = counted ? parseUnits(units) : 0;
    if (count === null || (counted && count <= 0)) return setError(`Укажи, сколько ${symbol(pot.currency)}.`);
    const sign = side === 'buy' ? 1 : -1;
    try {
      const res = await withRecalc((recalc) => api.post(`${base}/pots/${pot.id}/moves`, { date, amount: sign * value, units: sign * count, comment: '', recalc }));
      if (res === null) return;
      setError(null);
      setDone(`${side === 'buy' ? words.buy : words.sell}: ${money(value)}${counted ? ` (${amount(count)} ${symbol(pot.currency)})` : ''}. ${side === 'buy' ? 'Деньги взяты из свободных средств.' : 'Деньги вернулись в свободные средства.'}`);
      setSum('');
      setUnits('');
      setManual({ sum: false, units: false });
      await onChanged();
    } catch (e) {
      setDone(null);
      setError((e as Error).message);
    }
  }

  return (
    <Section inline={inline} title={asset ? (owned ? 'Вложение или продажа' : 'Покупка') : `${words.buy} или ${words.sell.toLowerCase()}`}>
        {error && <Banner kind="error">{error}</Banner>}
        {done && <Banner kind="ok">{done}</Banner>}
        {(!asset || owned) && <Segmented value={side} options={[['buy', words.buy], ['sell', words.sell]]} onChange={setSide} />}
        {asset && side === 'sell' && <p className="muted small">Продажа отдаёт актив целиком.</p>}
        {counted && (
          <p className="muted small">
            {perUnit
              ? `Курс на ${dayMonth(date)}: 1 ${symbol(pot.currency)} = ${amount(perUnit)} ${symbol()}${quote.data!.rateOnDate ? '' : ' (последний известный)'}. Введи одно поле, второе посчитается; его можно поправить.`
              : quote.error ? 'Курс не загрузился: введи оба поля.' : 'Загружаю курс…'}
          </p>
        )}
        <div className="inline-form wrap">
          <input aria-label={`Сумма, ${symbol()}`} inputMode="decimal" placeholder={`Сумма, ${symbol()}`} value={sum} onChange={(e) => type('sum', numberInput(e.target.value))} />
          {counted && <input aria-label={`Сколько, ${symbol(pot.currency)}`} inputMode="decimal" placeholder={`Сколько, ${symbol(pot.currency)}`} value={units} onChange={(e) => type('units', numberInput(e.target.value, { decimals: 8 }))} />}
          <DateInput label="Дата" value={date} onChange={setDate} />
          <Button small onClick={save}>{side === 'buy' ? words.buy : words.sell}</Button>
        </div>
    </Section>
  );
}

/** Начальный остаток вклада: что было на старте базы. Входит в итоги с первого месяца, со свободных не списывается. */
function OpeningEditor({ base, pot, onChanged }: { base: string; pot: Pot; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [balance, setBalance] = useState('');
  const [count, setCount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const counted = pot.kind === 'currency' || pot.kind === 'stock';
  const unitLabel = pot.kind === 'stock' ? 'шт.' : symbol(pot.currency);
  const summary = `${money(pot.openingBalance)}${counted ? ` · ${amount(pot.openingUnits, 4)} ${unitLabel}` : ''}`;
  if (!editing) {
    return (
      <button type="button" className="link" onClick={() => { setBalance(toInput(pot.openingBalance)); setCount(pot.openingUnits ? String(pot.openingUnits).replace('.', ',') : ''); setError(null); setEditing(true); }}>
        Начальный остаток: {summary}
      </button>
    );
  }
  async function save() {
    const value = balance.trim() ? parseMoney(balance) : 0;
    if (value === null || value < 0) return setError('Проверь сумму.');
    const units = counted && count.trim() ? parseUnits(count) : 0;
    if (units === null || units < 0) return setError('Проверь количество.');
    try {
      const res = await withRecalc((recalc) => api.patch(`${base}/pots/${pot.id}`, { openingBalance: value, ...(counted ? { openingUnits: units } : {}), recalc }));
      if (res === null) return;
      setEditing(false);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="stack">
      {error && <Banner kind="error">{error}</Banner>}
      <p className="muted small">{pot.kind === 'asset' ? 'Стоимость актива, который был на старте базы.' : 'Что было во вкладе на старте базы.'} Входит в итоги с первого месяца и не списывается со свободных средств, поэтому меняет «Всего» во всех месяцах.</p>
      <label className="field"><span>{pot.kind === 'asset' ? `Стоимость, ${symbol()}` : `Вложено, ${symbol()}`}</span><input inputMode="decimal" value={balance} onChange={(e) => setBalance(numberInput(e.target.value))} /></label>
      {counted && <label className="field"><span>Было, {unitLabel}</span><input inputMode="decimal" value={count} onChange={(e) => setCount(numberInput(e.target.value, { decimals: 8 }))} /></label>}
      <div className="inline-form">
        <Button small onClick={save}>Сохранить</Button>
        <Button small onClick={() => setEditing(false)}>Отмена</Button>
      </div>
    </div>
  );
}

/** Название вклада: на суммы не влияет, меняется в любой момент. */
function RenamePot({ base, pot, onChanged }: { base: string; pot: Pot; onChanged: () => Promise<void> }) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (name === null) return <button type="button" className="link" onClick={() => setName(pot.name)}>Переименовать</button>;
  async function save() {
    try {
      await api.patch(`${base}/pots/${pot.id}`, { name });
      setError(null);
      setName(null);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="stack">
      {error && <Banner kind="error">{error}</Banner>}
      <div className="inline-form">
        <input aria-label="Название вклада" value={name} onChange={(e) => setName(e.target.value)} />
        <Button small onClick={save}>Сохранить</Button>
        <Button small onClick={() => setName(null)}>Отмена</Button>
      </div>
    </div>
  );
}

function dealTitle(pot: Pot, m: PotQuotes['moves'][number]): string {
  if (m.units > 0) return 'Покупка';
  if (m.units < 0) return 'Продажа';
  if (pot.kind === 'asset') return m.amount > 0 ? 'Вложение' : 'Возврат';
  return m.amount > 0 ? 'Перевод во вклад' : 'Вывод из вклада';
}

/**
 * Сделки вклада. Администратор правит дату, сумму, количество и комментарий или убирает сделку;
 * покупка остаётся покупкой, продажа продажей. В закрытом месяце правка спросит согласие на пересчёт и попадёт в журнал.
 */
/** Подсказка под ценой акции: во сколько обойдётся сделка */
function stockSumHint(count: string, price: string, priceIn: 'stock' | 'base', foreign: boolean, currency: string): string {
  const units = parseUnits(count);
  const each = parseUnits(price);
  if (!units || !each) return 'Сумма посчитается по количеству и цене.';
  if (!foreign || priceIn === 'base') return `Сумма: ${money(Math.round(units * each * 100))}`;
  return `Сумма: ${amount(units * each)} ${symbol(currency)}, в ${symbol()} пересчитается по курсу Нацбанка на дату сделки`;
}

function Deals({ base, pot, moves, unit, isAdmin, onChanged }: {
  base: string;
  pot: Pot;
  moves: PotQuotes['moves'];
  unit: string;
  isAdmin: boolean;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [sum, setSum] = useState('');
  const [count, setCount] = useState('');
  const [comment, setComment] = useState('');
  const [price, setPrice] = useState('');
  const [priceIn, setPriceIn] = useState<'stock' | 'base'>('stock');
  const [error, setError] = useState<string | null>(null);
  const counted = pot.kind === 'currency' || pot.kind === 'stock';
  const stock = pot.kind === 'stock';
  const foreign = symbol(pot.currency) !== symbol();

  function edit(m: PotQuotes['moves'][number]) {
    setEditing(m.id);
    setDate(m.date);
    setSum(toInput(Math.abs(m.amount)));
    setCount(m.units ? String(Math.abs(m.units)) : '');
    setComment(m.comment);
    setPrice(m.price !== null ? String(Math.round(m.price * 10000) / 10000).replace('.', ',') : '');
    setPriceIn('stock');
    setError(null);
  }

  async function save(m: PotQuotes['moves'][number]) {
    const units = counted && count.trim() ? parseUnits(count) : 0;
    if (units === null) return setError('Проверь количество.');
    // У акций сумма считается на сервере по цене за штуку; у остального вводится сама сумма
    const each = stock ? parseUnits(price) : null;
    if (stock && (each === null || each <= 0)) return setError('Проверь цену за штуку.');
    if (stock && !units) return setError('Укажи количество акций.');
    const value = stock ? Math.abs(m.amount) : parseMoney(sum);
    if (!value || value <= 0) return setError('Проверь сумму.');
    // Знак сделки сохраняется: что было покупкой или переводом во вклад, тем и остаётся
    const sign = m.amount < 0 ? -1 : 1;
    try {
      const body = { date, amount: sign * value, units: counted ? sign * Math.abs(units) : m.units, comment, ...(stock ? { price: each, priceIn } : {}) };
      if ((await withRecalc((recalc) => api.put(`${base}/pots/${pot.id}/moves/${m.id}`, { ...body, recalc }))) === null) return;
      setEditing(null);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(m: PotQuotes['moves'][number]) {
    if (!(await confirmAction(`Убрать сделку «${dealTitle(pot, m)}» на ${money(Math.abs(m.amount))} от ${shortDate(m.date)}? Итоги пересчитаются.`))) return;
    try {
      if ((await withRecalc((recalc) => api.del(`${base}/pots/${pot.id}/moves/${m.id}${recalc ? '?recalc=1' : ''}`))) === null) return;
      setEditing(null);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!moves.length) return <p className="muted">{pot.kind === 'asset' ? 'Сделок нет: актив был до начала учёта.' : 'Сделок пока нет.'}</p>;
  return (
    <ul className="tag-rank">
      {[...moves].reverse().map((m) => {
        const body = (
          <>
            <div className="fund-top"><span className="entry-title">{dealTitle(pot, m)}</span><b>{money(Math.abs(m.amount))}</b></div>
            <div className="fund-bottom muted small">
              <span>{shortDate(m.date)}{m.comment && ` · ${m.comment}`}</span>
              {counted && m.units !== 0 && <span>{amount(Math.abs(m.units), 4)}{m.price !== null && ` по ${amount(m.price)} ${unit}`}</span>}
            </div>
          </>
        );
        if (editing === m.id) {
          return (
            <li key={m.id}>
              <div className="static">
                {body}
                {error && <Banner kind="error">{error}</Banner>}
                <div className="field">
                  <span>Дата сделки</span>
                  <DateInput label="Дата сделки" value={date} onChange={setDate} />
                </div>
                {counted && (
                  <label className="field">
                    <span>{stock ? 'Количество акций, шт.' : `Сумма в ${symbol(pot.currency)}`}</span>
                    <input inputMode="decimal" value={count} onChange={(e) => setCount(numberInput(e.target.value, { decimals: 8 }))} />
                  </label>
                )}
                {stock ? (
                  <div className="field">
                    <span>Цена за одну акцию</span>
                    <div className="inline-form">
                      <input aria-label="Цена за одну акцию" inputMode="decimal" value={price} onChange={(e) => setPrice(numberInput(e.target.value, { decimals: 6 }))} />
                      {foreign && (
                        <select aria-label="Валюта цены" value={priceIn} onChange={(e) => setPriceIn(e.target.value as 'stock' | 'base')}>
                          <option value="stock">{symbol(pot.currency)}</option>
                          <option value="base">{symbol()}</option>
                        </select>
                      )}
                    </div>
                    <small className="muted">{stockSumHint(count, price, priceIn, foreign, pot.currency)}</small>
                  </div>
                ) : (
                  <label className="field">
                    <span>Сумма в {symbol()}</span>
                    <input inputMode="decimal" value={sum} onChange={(e) => setSum(numberInput(e.target.value))} />
                  </label>
                )}
                <label className="field">
                  <span>Комментарий</span>
                  <input value={comment} onChange={(e) => setComment(e.target.value)} />
                </label>
                <div className="inline-form">
                  <Button small onClick={() => save(m)}>Сохранить</Button>
                  <Button small onClick={() => remove(m)}>Убрать</Button>
                  <Button small onClick={() => setEditing(null)}>Отмена</Button>
                </div>
              </div>
            </li>
          );
        }
        return <li key={m.id}>{isAdmin ? <button type="button" onClick={() => edit(m)}>{body}</button> : <div className="static">{body}</div>}</li>;
      })}
    </ul>
  );
}

function PriceChart({ points, buys, average, unit, period }: {
  points: { date: string; price: number }[];
  buys: PotQuotes['moves'];
  average: number | null;
  unit: string;
  period: Period;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 340;
  const H = 200;
  const pad = { l: 46, r: 8, t: 10, b: 22 };
  const prices = [...points.map((p) => p.price), ...buys.map((b) => b.price!), ...(average !== null ? [average] : [])];
  const ticks = niceTicks(Math.min(...prices), Math.max(...prices));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const start = Date.parse(points[0].date);
  const span = Date.parse(points[points.length - 1].date) - start || 1;
  const x = (date: string) => pad.l + ((Date.parse(date) - start) / span) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - ((v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const short = period === '1m' || period === '3m';
  // Подписи по оси: первые дни месяцев или равные отрезки на коротком периоде
  const labels = short
    ? [0, 0.25, 0.5, 0.75, 1].map((f) => points[Math.round(f * (points.length - 1))])
    : points.filter((p, i) => i > 0 && p.date.slice(0, 7) !== points[i - 1].date.slice(0, 7)).filter((_, i, list) => (list.length - 1 - i) % Math.ceil(list.length / 5) === 0);
  const active = hover !== null ? points[hover] : null;

  function pointer(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const time = start + ((px - pad.l) / (W - pad.l - pad.r)) * span;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(Date.parse(p.date) - time) < Math.abs(Date.parse(points[best].date) - time)) best = i; });
    setHover(best);
  }

  return (
    <figure className="chart">
      <div className="legend">
        <span><i style={{ background: 'var(--series-1)' }} />Цена</span>
        {buys.length > 0 && <span><i className="dot" style={{ background: 'var(--series-3)' }} />Покупки</span>}
        {average !== null && <span><i className="dashed" style={{ borderColor: 'var(--series-2)' }} />Средняя покупки</span>}
      </div>
      <div className="chart-readout" aria-live="polite">
        {active ? (
          <>
            <b>{dayMonth(active.date, true)}</b>
            <span>{amount(active.price)} {unit}</span>
            {average !== null && <span className={tone(active.price - average)}>{percent(active.price / average - 1)} к средней покупки</span>}
          </>
        ) : (
          <span className="muted">Нажми на график, чтобы увидеть цену на дату</span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Цена за период, ${unit}`} onPointerMove={pointer} onPointerDown={pointer} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="tick">{amount(t)}</text>
          </g>
        ))}
        {labels.map((p) => (
          <text key={p.date} x={Math.min(Math.max(x(p.date), pad.l + 14), W - pad.r - 14)} y={H - 6} textAnchor="middle" className="tick">{short ? dayMonth(p.date) : monthShort(p.date.slice(0, 7))}</text>
        ))}
        {average !== null && <line x1={pad.l} x2={W - pad.r} y1={y(average)} y2={y(average)} stroke="var(--series-2)" strokeWidth="1.5" strokeDasharray="5 4" />}
        <polyline fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={points.map((p) => `${x(p.date)},${y(p.price)}`).join(' ')} />
        {buys.map((b, i) => (
          <circle key={i} cx={x(b.date)} cy={y(b.price!)} r="4.5" fill={b.units > 0 ? 'var(--series-3)' : 'var(--danger)'} className="marker" />
        ))}
        {active && (
          <>
            <line x1={x(active.date)} x2={x(active.date)} y1={pad.t} y2={H - pad.b} className="crosshair" />
            <circle cx={x(active.date)} cy={y(active.price)} r="4" fill="var(--series-1)" className="marker" />
          </>
        )}
      </svg>
    </figure>
  );
}

/** Перевод во вклад, продажа и новый вклад. */
/**
 * Покупка и продажа акций по тикеру: штуки и цена за штуку в валюте акции. Вклад под новый тикер сервер заводит сам,
 * сумма в основной валюте считается по курсу на дату сделки.
 */
/** fixed: форма внутри карточки акции, тикер уже выбран */
function StockTrade({ base, pots, fixed, inline, onChanged }: { base: string; pots: Pot[]; fixed?: Pot; inline?: boolean; onChanged: () => Promise<void> }) {
  const stocks = pots.filter((p) => p.kind === 'stock' && p.ticker);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [ticker, setTicker] = useState(fixed?.ticker ?? '');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [units, setUnits] = useState('');
  const [price, setPrice] = useState('');
  const [priceIn, setPriceIn] = useState<'stock' | 'base'>('stock');
  const [date, setDate] = useState(today());
  // Цена, введённая руками, не перезаписывается котировкой
  const [priceManual, setPriceManual] = useState(false);
  const known = stocks.find((p) => p.ticker === ticker.trim().toUpperCase());
  const owned = known ? known.units : 0;
  // Котировка на дату сделки для знакомого тикера; для нового тикера цену вводят сами
  const quote = useLoad<MarketPrice>(known ? `${base}/market/price?date=${date}&ticker=${encodeURIComponent(known.ticker!)}` : null);
  const autoPrice = quote.data ? (priceIn === 'stock' ? quote.data.price : quote.data.price * quote.data.rate) : null;
  useEffect(() => {
    if (!priceManual) setPrice(autoPrice ? decimalInput(autoPrice, 2) : '');
  }, [autoPrice, priceManual]);
  const count = parseUnits(units);
  const each = parseUnits(price);
  const total = count && each && (priceIn === 'base' || quote.data) ? count * each * (priceIn === 'base' ? 1 : quote.data!.rate) : null;

  function pickTicker(value: string) {
    setTicker(value);
    setPriceManual(false);
  }

  async function trade() {
    const count = parseUnits(units);
    const each = parseUnits(price);
    if (!ticker.trim()) return setError('Укажи тикер, например AAPL.');
    if (count === null || count <= 0) return setError('Проверь количество.');
    if (each === null || each <= 0) return setError('Проверь цену за штуку.');
    try {
      const send = (priceChecked: boolean) =>
        withRecalc((recalc) => api.post<{ amount: number; rate: number }>(`${base}/stocks/trade`, { ticker, side, units: count, price: each, priceIn, priceChecked, date, recalc }));
      let res;
      try {
        res = await send(false);
      } catch (e) {
        // Цена далеко от котировки: чаще всего перепутана валюта, но сделка может быть и настоящей
        if (!(e instanceof ApiError) || e.status !== 422) throw e;
        if (!(await confirmAction(`${e.message} Всё равно записать?`))) return;
        res = await send(true);
      }
      if (res === null) return;
      setError(null);
      setDone(`${side === 'buy' ? 'Куплено' : 'Продано'}: ${ticker.trim().toUpperCase()} ${amount(count, 4)} шт. на ${money(Math.abs(res.amount))}${res.rate !== 1 ? ` (курс ${amount(res.rate)})` : ''}. ${side === 'buy' ? 'Деньги взяты из свободных средств.' : 'Деньги вернулись в свободные средства.'}`);
      setUnits('');
      setPriceManual(false);
      await onChanged();
    } catch (e) {
      setDone(null);
      setError((e as Error).message);
    }
  }

  return (
    <Section inline={inline} title={fixed ? 'Купить или продать' : 'Купить или продать акции'}>
        {error && <Banner kind="error">{error}</Banner>}
        {done && <Banner kind="ok">{done}</Banner>}
        <p className="muted small">Тикер, количество и цена за одну акцию: в валюте акции или в {symbol()}, если брокер показывает в {symbol()}. Для нового тикера вклад появится сам. Сумма в {symbol()} считается по курсу Нацбанка на дату сделки, а если его нет, по последнему.</p>
        <div className="inline-form wrap">
          <select aria-label="Сделка" value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}>
            <option value="buy">Покупка</option>
            <option value="sell">Продажа</option>
          </select>
          {!fixed && <input aria-label="Тикер" placeholder="Тикер: AAPL" autoCapitalize="characters" list="stock-tickers" value={ticker} onChange={(e) => pickTicker(e.target.value)} />}
          {!fixed && <datalist id="stock-tickers">{stocks.map((p) => <option key={p.id} value={p.ticker!}>{p.name}</option>)}</datalist>}
          <input aria-label="Количество" inputMode="decimal" placeholder={side === 'sell' && known ? `Шт., есть ${amount(owned, 4)}` : 'Шт.'} value={units} onChange={(e) => setUnits(numberInput(e.target.value, { decimals: 8 }))} />
          <input aria-label="Цена за штуку" inputMode="decimal" placeholder="Цена за шт." value={price} onChange={(e) => { const text = numberInput(e.target.value, { decimals: 6 }); setPrice(text); setPriceManual(text.trim() !== ''); }} />
          <select aria-label="Валюта цены" value={priceIn} onChange={(e) => setPriceIn(e.target.value as 'stock' | 'base')}>
            <option value="stock">{known ? symbol(known.currency) : 'в валюте акции'}</option>
            <option value="base">{symbol()}</option>
          </select>
          <DateInput label="Дата сделки" value={date} onChange={setDate} />
          <Button small onClick={trade}>{side === 'buy' ? 'Купить' : 'Продать'}</Button>
        </div>
        {known && (
          <p className="muted small">
            {quote.data
              ? `Котировка ${known.ticker} на ${dayMonth(quote.data.priceDate ?? date)}: ${amount(quote.data.price)} ${symbol(quote.data.currency)}${quote.data.rate !== 1 ? ` ≈ ${amount(quote.data.price * quote.data.rate)} ${symbol()}` : ''}. ${priceManual ? 'Цена введена вручную.' : 'Цена подставлена, её можно поправить.'}`
              : quote.error ? 'Котировка не загрузилась: введи цену сам.' : 'Загружаю котировку…'}
            {total !== null && ` Сумма ≈ ${money(Math.round(total * 100))}.`}
          </p>
        )}
    </Section>
  );
}

function PotsManager({ base, pots, baseCurrency, onChanged }: { base: string; pots: Pot[]; baseCurrency: string; onChanged: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Pot['kind']>('cash');
  const [currency, setCurrency] = useState(FOREIGN_CURRENCIES.find((c) => c !== baseCurrency)!);
  const [ticker, setTicker] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [openingUnits, setOpeningUnits] = useState('');
  const [pot, setPot] = useState<number | ''>('');
  const selected = pots.find((p) => p.id === pot);

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      setError(null);
      await onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function create() {
    const balance = openingBalance.trim() ? parseMoney(openingBalance) : 0;
    const count = kind !== 'cash' && kind !== 'asset' && openingUnits.trim() ? parseUnits(openingUnits) : 0;
    if (balance === null || count === null) return setError('Проверь стартовые суммы.');
    const body = { name, kind, openingBalance: balance, openingUnits: count, ...(kind === 'currency' ? { currency } : {}), ...(kind === 'stock' ? { ticker } : {}) };
    if (await run(() => api.post(`${base}/pots`, body))) {
      setName('');
      setTicker('');
      setOpeningBalance('');
      setOpeningUnits('');
    }
  }

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      {pots.length > 0 && (
        <details className="section">
          <summary>Перевести во вклад или продать</summary>
          <div className="section-body">
            <p className="muted small">Покупка забирает деньги из свободных средств, продажа возвращает их туда. В доходы и расходы сделка не попадает. То же можно сделать в карточке вклада.</p>
            <select aria-label="Вклад" value={pot} onChange={(e) => setPot(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Выбери вклад</option>
              {pots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {selected && (selected.kind === 'stock' && selected.ticker
              ? <StockTrade key={selected.id} inline base={base} pots={[selected]} fixed={selected} onChanged={onChanged} />
              : <PotMove key={selected.id} inline base={base} pot={selected} onChanged={onChanged} />)}
          </div>
        </details>
      )}
      <details className="section">
        <summary>Новый вклад</summary>
        <div className="section-body">
          <div className="inline-form wrap">
            <select aria-label="Тип вклада" value={kind} onChange={(e) => setKind(e.target.value as Pot['kind'])}>
              <option value="cash">В основной валюте</option>
              <option value="currency">Валюта</option>
              <option value="stock">Акции</option>
              <option value="asset">Актив: недвижимость, машина</option>
            </select>
            <input aria-label="Название вклада" placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} />
            {kind === 'currency' && (
              <select aria-label="Валюта" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {FOREIGN_CURRENCIES.filter((c) => c !== baseCurrency).map((c) => <option key={c}>{c}</option>)}
              </select>
            )}
            {kind === 'stock' && <input aria-label="Тикер" placeholder="Тикер: AAPL" autoCapitalize="characters" value={ticker} onChange={(e) => setTicker(e.target.value)} />}
            <input aria-label="Уже вложено" inputMode="text" placeholder={kind === 'asset' ? `Стоимость, если уже есть, ${symbol()}` : `Уже вложено, ${symbol()}`} value={openingBalance} onChange={(e) => setOpeningBalance(numberInput(e.target.value))} />
            {kind !== 'cash' && kind !== 'asset' && <input aria-label="Уже есть" inputMode="text" placeholder={kind === 'stock' ? 'Уже есть, шт.' : `Уже есть, ${symbol(currency)}`} value={openingUnits} onChange={(e) => setOpeningUnits(numberInput(e.target.value, { decimals: 8 }))} />}
          </div>
          <p className="muted small">{kind === 'asset' ? 'Уже имеющийся актив входит в общий итог с первого месяца базы и не списывается со свободных средств. Новый заводится без суммы, а потом покупается переводом.' : 'То, что уже есть, не списывается со свободных средств, но входит в общий итог.'}</p>
          <Button small onClick={create}>Создать</Button>
        </div>
      </details>
    </>
  );
}
