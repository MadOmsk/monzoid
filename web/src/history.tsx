import { useState } from 'react';
import { useLoad, type MemberStats, type MonthReport, type Summary, type TagStats } from './api';
import { useBack } from './back';
import { BASE_CURRENCIES, cell, fundLabel, memberLabel, moneyRounded as money, monthName, monthShort, niceTicks, planShare, shiftYm, signedCell, signedRounded as signed, symbol, tone } from './format';
import { PotsView } from './pots';
import { Banner, Header, Segmented, Spinner, useRemembered } from './ui';

interface Series<T> {
  label: string;
  cssVar: string;
  get: (row: T) => number;
}

const TOTAL_SERIES: Series<MonthReport>[] = [
  // Активы на графике не показываются: стоимость квартиры сплющила бы остальные линии. Они есть в таблице
  { label: 'Деньги', cssVar: '--series-1', get: (m) => m.moneyAfter },
  { label: 'Фонды', cssVar: '--series-2', get: (m) => m.fundsAfter },
  { label: 'Свободные', cssVar: '--series-3', get: (m) => m.freeAfter },
  { label: 'Вклады', cssVar: '--series-4', get: (m) => m.potsAfter },
];

type View = 'totals' | 'funds' | 'pots' | 'incomes' | 'members' | 'tags';

export function HistoryScreen({ base, startYm, currentYm, isAdmin, currency }: { base: string; startYm: string; currentYm: string; isAdmin: boolean; currency: string }) {
  const { data, error } = useLoad<{ months: MonthReport[] }>(`${base}/history`);
  const [storedView, setCurrentView] = useRemembered<View | 'month'>(`${base}:view`, 'totals');
  // Вкладка «Месяц» переехала на главный экран месяца: старое запомненное значение ведёт на итоги
  const view: View = storedView === 'month' ? 'totals' : storedView;
  const [fundId, setCurrentFund] = useRemembered<number | null>(`${base}:fund`, null);
  const [fundsMode, setFundsMode] = useRemembered<FundsMode>(`${base}:fundsMode`, 'balance');
  // Снятые линии графика итогов запоминаются в браузере для каждой базы
  const [totalsHidden, setTotalsHidden] = useHiddenSet(`monzoid:totals-hidden:${base}`);
  const [trail, setTrail] = useState<{ view: View; fundId: number | null }[]>([]);
  const go = (nextView: View, nextFund: number | null) => {
    if (nextView === view && nextFund === fundId) return;
    setTrail((t) => [...t, { view, fundId }]);
    setCurrentView(nextView);
    setCurrentFund(nextFund);
    window.scrollTo(0, 0);
  };
  const setView = (next: View) => go(next, fundId);
  const back = () => {
    const previous = trail[trail.length - 1];
    setCurrentView(previous.view);
    setCurrentFund(previous.fundId);
    setTrail((t) => t.slice(0, -1));
    window.scrollTo(0, 0);
  };
  useBack(trail.length > 0, 1, back);

  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) return <Spinner />;
  // Статистика строится по закрытым месяцам; незакрытые прошлые видны только в «Капитале», серыми
  const allMonths = data.months;
  const months = allMonths.filter((m) => m.closed);
  const openFund = view === 'funds' && fundId !== null ? months.flatMap((m) => m.funds).find((f) => f.id === fundId) : undefined;
  if (openFund) {
    return (
      <>
        <Header title={fundLabel(openFund.name)} onBack={back} />
        <FundDetail key={openFund.id} months={months} fundId={openFund.id} />
      </>
    );
  }
  const tabs = <Segmented value={view} options={[['totals', 'Капитал'], ['funds', 'Фонды'], ['incomes', 'Доходы'], ['pots', 'Вклады/Активы'], ['members', 'Люди'], ['tags', 'Теги']]} onChange={setView} />;
  const noMonths = <p className="muted">Здесь появится динамика после закрытия первого месяца.</p>;

  return (
    <>
      <h1>Статистика</h1>
      {/* Вкладки и переключатель фондов не уходят при прокрутке */}
      <div className="sticky-head">
        {tabs}
        {view === 'funds' && months.length > 0 && <Segmented value={fundsMode} options={[['balance', 'Остатки'], ['spent', 'Факт'], ['planned', 'План']]} onChange={setFundsMode} />}
      </div>
      {view === 'pots' && <PotsView base={base} isAdmin={isAdmin} currency={currency} months={months} currentYm={currentYm} />}
      {view === 'incomes' && <IncomesView base={base} />}
      {view === 'members' && <MembersView base={base} />}
      {view === 'tags' && <TagsView base={base} />}
      {((view === 'totals' && !allMonths.length) || (view === 'funds' && !months.length)) && noMonths}
      {view === 'totals' && allMonths.length > 0 && (
        <>
          {months.length > 1 ? <LineChart rows={months} series={TOTAL_SERIES} hidden={totalsHidden} onHidden={setTotalsHidden} label="Деньги, фонды, свободные и вклады по закрытым месяцам без активов, все данные в таблице ниже" /> : <p className="muted">График появится после закрытия второго месяца.</p>}
          <TotalsTable base={base} months={allMonths} currency={currency} currentYm={currentYm} />
        </>
      )}
      {view === 'funds' && months.length > 0 && <FundsTable base={base} months={months} currentYm={currentYm} mode={fundsMode} onOpen={(id) => go('funds', id)} />}
    </>
  );
}

function compact(tiyn: number): string {
  const tenge = tiyn / 100;
  const abs = Math.abs(tenge);
  const text = abs >= 1_000_000 ? `${(tenge / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)} млн` : abs >= 1000 ? `${Math.round(tenge / 1000)} тыс` : String(Math.round(tenge));
  return text.replace('-', '−');
}

const LABEL_GAP = 58;
// Дальше линии по месяцам сливаются в сплошной фон
const MAX_MONTH_LINES = 40;

// Окно тренда в месяцах: сглаживает разовые всплески, но оставляет сезонные изменения
const TREND_WINDOW = 7;
// Проходы, в которых снижается вес выбивающихся месяцев (разовый кешбек, продажа)
const TREND_ROBUST_PASSES = 2;

/** Значение в точке x локальной прямой по ближайшим месяцам с весами (чем ближе месяц, тем важнее). */
function localLine(values: number[], robust: number[], x: number): number {
  const n = values.length;
  const k = Math.min(n, TREND_WINDOW);
  const distances = values.map((_, i) => Math.abs(i - x)).sort((a, b) => a - b);
  // Ширина окна до k-го ближайшего месяца; чуть шире, чтобы крайний месяц не получал нулевой вес
  const h = Math.max(distances[k - 1], 0.5) * 1.001;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  values.forEach((v, i) => {
    const d = Math.abs(i - x) / h;
    if (d >= 1) return;
    const w = (1 - d ** 3) ** 3 * robust[i];
    sw += w;
    sx += w * i;
    sy += w * v;
    sxx += w * i * i;
    sxy += w * i * v;
  });
  // Все соседи признаны выбросами: тогда считаем без защиты, иначе кривая скачет
  if (sw < 1e-6) return robust.every((r) => r === 1) ? values[Math.round(x)] : localLine(values, values.map(() => 1), x);
  const meanX = sx / sw;
  const meanY = sy / sw;
  const varX = sxx / sw - meanX ** 2;
  const slope = varX > 1e-9 ? (sxy / sw - meanX * meanY) / varX : 0;
  return meanY + slope * (x - meanX);
}

/**
 * Тренд методом LOESS: для каждой точки своя прямая по соседним месяцам, из них складывается плавная кривая.
 * Ведёт себя одинаково на коротком и длинном периоде, а месяцы, сильно выбивающиеся из соседей, почти не влияют.
 */
function loessTrend(values: number[]) {
  let robust = values.map(() => 1);
  for (let pass = 0; pass < TREND_ROBUST_PASSES; pass++) {
    const residuals = values.map((v, i) => Math.abs(v - localLine(values, robust, i)));
    const median = [...residuals].sort((a, b) => a - b)[Math.floor(residuals.length / 2)];
    if (median < 1e-9) break;
    robust = residuals.map((r) => {
      const u = r / (6 * median);
      return u < 1 ? (1 - u * u) ** 2 : 0;
    });
  }
  return { at: (x: number) => localLine(values, robust, x) };
}

// Кривая тренда рисуется по промежуточным точкам между месяцами, чтобы была гладкой
const TREND_STEPS = 8;

/**
 * hidden и onHidden включают галочки в легенде: снятая линия пропадает с графика, и шкала перестраивается.
 */
function LineChart<T extends { ym: string }>({ rows, series: allSeries, label, title, hidden, onHidden }: {
  rows: T[];
  series: Series<T>[];
  label: string;
  title?: string;
  hidden?: Set<string>;
  onHidden?: (next: Set<string>) => void;
}) {
  const series = hidden ? allSeries.filter((s) => !hidden.has(s.label)) : allSeries;
  const [hover, setHover] = useState<number | null>(null);
  const [mode, setMode] = useState<'values' | 'change'>('values');
  const W = 340;
  const H = 200;
  const pad = { l: 46, r: 8, t: 10, b: 22 };
  // Для изменения нужна пара соседних месяцев, поэтому режим появляется от трёх месяцев
  const canChange = rows.length > 2;
  const change = canChange && mode === 'change';
  const points = change
    ? rows.slice(1).map((m, i) => ({ ym: m.ym, values: series.map((s) => s.get(m) - s.get(rows[i])) }))
    : rows.map((m) => ({ ym: m.ym, values: series.map((s) => s.get(m)) }));
  // Сглаженный тренд каждой линии: от трёх точек, иначе тренд ничего не говорит
  const trends = points.length > 2 ? series.map((_, j) => loessTrend(points.map((p) => p.values[j]))) : [];
  const steps = Array.from({ length: (points.length - 1) * TREND_STEPS + 1 }, (_, k) => k / TREND_STEPS);
  const curves = trends.map((t) => steps.map((i) => [i, t.at(i)] as const));
  // Шкала строится по данным: кривая на краях может уходить дальше, она обрезается рамкой графика
  const values = points.flatMap((p) => p.values);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / (points.length - 1);
  const y = (v: number) => H - pad.b - ((v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const labelEvery = Math.ceil(points.length / 6);
  // Подпись не ставится вплотную к последней: та прижата к правому краю и шире середины
  const labelled = (i: number) => (points.length - 1 - i) % labelEvery === 0 && (i === points.length - 1 || x(points.length - 1) - x(i) >= LABEL_GAP);
  const active = hover !== null ? points[hover] : null;

  function pointer(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }

  return (
    <figure className="chart">
      {title && <figcaption className="chart-title">{title}</figcaption>}
      {canChange && (
        <div className="chart-mode">
          <Segmented value={mode} options={[['values', 'Значения'], ['change', `Темп роста, ${symbol()} в месяц`]]} onChange={(next) => { setHover(null); setMode(next); }} />
        </div>
      )}
      {hidden && onHidden ? (
        <div className="category-toggles">
          {allSeries.map((s) => (
            <label key={s.label} className={`category-toggle${hidden.has(s.label) ? ' muted' : ''}`}>
              <input
                type="checkbox"
                checked={!hidden.has(s.label)}
                onChange={() => {
                  const next = new Set(hidden);
                  if (next.has(s.label)) next.delete(s.label);
                  else next.add(s.label);
                  setHover(null);
                  onHidden(next);
                }}
                style={{ accentColor: `var(${s.cssVar})` }}
              />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      ) : (
        series.length > 1 && (
          <div className="legend">
            {series.map((s) => (
              <span key={s.label}><i style={{ background: `var(${s.cssVar})` }} />{s.label}</span>
            ))}
          </div>
        )
      )}
      <div className="chart-readout" aria-live="polite">
        {active ? (
          <>
            <b>{monthName(active.ym)}</b>
            {series.map((s, j) => <span key={s.label}>{s.label}: {change ? signed(active.values[j]) : money(active.values[j])}</span>)}
          </>
        ) : (
          <span className="muted">Нажми на график, чтобы увидеть месяц{trends.length > 0 && '. Бледный пунктир это тренд'}</span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onPointerMove={pointer} onPointerDown={pointer} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-zero' : 'grid'} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="tick">{compact(t)}</text>
          </g>
        ))}
        {/* Подписи отсчитываются от последнего месяца: так он всегда подписан и ни с кем не наезжает */}
        {points.length <= MAX_MONTH_LINES && points.map((p, i) => <line key={`v${p.ym}`} x1={x(i)} x2={x(i)} y1={pad.t} y2={H - pad.b} className="grid-month" />)}
        {points.map((p, i) => (labelled(i) ? <text key={p.ym} x={x(i)} y={H - 6} textAnchor={i === points.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'} className="tick">{monthShort(p.ym)}</text> : null))}
        <clipPath id="trend-clip"><rect x={pad.l} y={pad.t} width={W - pad.l - pad.r} height={H - pad.t - pad.b} /></clipPath>
        {curves.map((curve, j) => (
          <polyline key={`t${series[j].label}`} fill="none" stroke={`var(${series[j].cssVar})`} strokeOpacity="0.4" strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" strokeLinecap="round" clipPath="url(#trend-clip)" points={curve.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')} />
        ))}
        {series.map((s, j) => (
          <polyline key={s.label} fill="none" stroke={`var(${s.cssVar})`} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={points.map((p, i) => `${x(i)},${y(p.values[j])}`).join(' ')} />
        ))}
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="crosshair" />
            {series.map((s, j) => (
              <circle key={s.label} cx={x(hover)} cy={y(points[hover].values[j])} r="4" fill={`var(${s.cssVar})`} className="marker" />
            ))}
          </>
        )}
      </svg>
    </figure>
  );
}

function ValueCell({ value, delta, strong }: { value: number; delta: number; strong?: boolean }) {
  return (
    <td>
      <div>{strong ? <b>{cell(value)}</b> : cell(value)}</div>
      <div className={`cell-delta ${tone(delta) || 'muted'}`}>{signedCell(delta)}</div>
    </td>
  );
}

type TotalsMode = 'money' | 'currency' | 'capital';

function TotalsTable({ base, months: closedMonths, currency, currentYm }: { base: string; months: MonthReport[]; currency: string; currentYm: string }) {
  // Текущий незакрытый месяц: первой строкой «сейчас», цифры ещё меняются
  const openYm = closedMonths.length && closedMonths.at(-1)!.ym < currentYm ? currentYm : null;
  const { data: now } = useLoad<Summary>(openYm ? `${base}/summary?ym=${openYm}` : null);
  // Внутри открытого месяца план входит в фонды по дням (за первый день 1/30), траты месяца из фондов уже вычтены,
  // а свободные это деньги на сегодня минус эти фонды
  const last = closedMonths.at(-1);
  const liveFunds = now ? now.report.fundsAfter - Math.round(now.report.plannedTotal * (1 - planShare(now.report.ym))) : 0;
  const live = now && openYm && last && last.ym === shiftYm(openYm, -1)
    ? { ...now.report, fundsAfter: liveFunds, fundsDelta: liveFunds - last.fundsAfter, freeAfter: now.report.moneyAfter - liveFunds, freeDelta: now.report.moneyAfter - liveFunds - last.freeAfter }
    : null;
  const months = live ? [...closedMonths, live] : closedMonths;
  // «Тенге» из «Тенге, ₸»: название подвкладки по валюте базы
  const baseName = (BASE_CURRENCIES.find(([code]) => code === currency)?.[1] ?? currency).split(',')[0];
  const [mode, setMode] = useRemembered<TotalsMode>(`${base}:totalsMode`, 'money');
  const rows = months.map((m, i) => {
    // В первом месяце сравнивать стоимость не с чем, поэтому показано только вложенное
    const potsDelta = i === 0 ? m.potMoves : m.potsAfter - months[i - 1].potsAfter;
    const assetsDelta = i === 0 ? m.assetMoves : m.assetsAfter - months[i - 1].assetsAfter;
    const moneyDelta = m.freeDelta + m.fundsDelta;
    const currencyDelta = i === 0 ? m.currencyAfter : m.currencyAfter - months[i - 1].currencyAfter;
    const stocksDelta = i === 0 ? m.stocksAfter : m.stocksAfter - months[i - 1].stocksAfter;
    return { m, potsDelta, assetsDelta, moneyDelta, currencyDelta, stocksDelta, totalDelta: moneyDelta + potsDelta + assetsDelta };
  }).reverse();
  const hasAssets = months.some((m) => m.assetsAfter !== 0 || m.assetsInvested !== 0);
  // Одна таблица с переключателем: все столбцы сразу не помещаются на экран телефона
  return (
    <>
      <h2>Деньги и капитал</h2>
      <Segmented value={mode} options={[['money', baseName], ['currency', 'Валюта и акции'], ['capital', 'Весь капитал']]} onChange={setMode} />
      <p className="muted small">
        {mode === 'money'
          ? `${baseName} это свободные средства и фонды.`
          : mode === 'currency'
          ? `${baseName} это свободные средства и фонды. Валюта и акции по курсу и котировкам на конец месяца.`
          : `${baseName} это свободные средства и фонды. Вклады это валюта и акции по курсу на конец месяца${hasAssets ? ', активы это недвижимость и машины по оценке' : ''}.`}
      </p>
      <div className="table-wrap">
        <table className="compact-table">
          <thead>
            {mode === 'money'
              ? <tr><th>Месяц</th><th>Свободные</th><th>Фонды</th><th>{baseName}</th></tr>
              : mode === 'currency'
              ? <tr><th>Месяц</th><th>{baseName}</th><th>Валюта</th><th>Акции</th><th>Всего</th></tr>
              : <tr><th>Месяц</th><th>{baseName}</th><th>Вклады</th>{hasAssets && <th>Активы</th>}<th>Всего</th></tr>}
          </thead>
          <tbody>
            {rows.map(({ m, moneyDelta, potsDelta, assetsDelta, currencyDelta, stocksDelta, totalDelta }) => (
              <tr key={m.ym} className={!m.closed && m.ym !== openYm ? 'open-month' : undefined}>
                <th scope="row">{m.closed ? monthShort(m.ym) : m.ym === openYm ? <>сейчас<br /><small className="muted">{monthShort(m.ym)}</small></> : <>{monthShort(m.ym)}<br /><small className="muted">не закрыт</small></>}</th>
                {mode === 'money' ? (
                  <>
                    <ValueCell value={m.freeAfter} delta={m.freeDelta} />
                    <ValueCell value={m.fundsAfter} delta={m.fundsDelta} />
                    <ValueCell value={m.moneyAfter} delta={moneyDelta} strong />
                  </>
                ) : mode === 'currency' ? (
                  <>
                    <ValueCell value={m.moneyAfter} delta={moneyDelta} />
                    <ValueCell value={m.currencyAfter} delta={currencyDelta} />
                    <ValueCell value={m.stocksAfter} delta={stocksDelta} />
                    <ValueCell value={m.moneyAfter + m.currencyAfter + m.stocksAfter} delta={moneyDelta + currencyDelta + stocksDelta} strong />
                  </>
                ) : (
                  <>
                    <ValueCell value={m.moneyAfter} delta={moneyDelta} />
                    <ValueCell value={m.potsAfter} delta={potsDelta} />
                    {hasAssets && <ValueCell value={m.assetsAfter} delta={assetsDelta} />}
                    <ValueCell value={m.totalAfter} delta={totalDelta} strong />
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function IncomesView({ base }: { base: string }) {
  const { data, error } = useLoad<IncomeCategory[]>(`${base}/incomes/categories`);
  const [hidden, setHidden] = useHiddenSet(`monzoid:income-hidden:${base}`);
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) return <Spinner />;
  if (!data.length) return <p className="muted">Здесь появятся доходы, когда они будут внесены.</p>;
  const sum = data.reduce((s, r) => s + r.total, 0);
  const months = new Set(data.map((r) => r.ym)).size;
  return (
    <>
      <div className="tiles">
        <div className="tile"><span>Всего за период</span><strong>{money(sum)}</strong></div>
        <div className="tile"><span>В среднем за месяц</span><strong>{money(sum / months)}</strong></div>
      </div>
      <IncomeCategories base={base} data={data} hidden={hidden} onHidden={setHidden} />
    </>
  );
}

interface IncomeCategory {
  ym: string;
  category: string;
  total: number;
}

// Отдельных строк категорий; мелкие (халтура, подарки, разовые продажи) складываются в «Прочее»
// Сколько категорий кроме зарплат получают свой столбец, чтобы таблица влезала в ширину телефона
const MAX_OTHER_COLUMNS = 2;
const SALARY = 'ЗП ';
const isSalary = (category: string) => category.startsWith(SALARY);
const OTHER = 'Прочее';
// Цвет линии закреплён за строкой таблицы
const CATEGORY_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];
// Пустой месяц без нуля, чтобы суммы читались
const full = (tiyn: number) => (tiyn ? cell(tiyn) : '');

/** Снятые галочки категорий; запоминаются в браузере для каждой базы, чтобы не слетать при уходе с экрана. */
function useHiddenSet(key: string, initial?: () => string[]): [Set<string>, (next: Set<string>) => void] {
  const [hidden, setState] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(key);
      return new Set(stored === null ? (initial?.() ?? []) : (JSON.parse(stored) as string[]));
    } catch {
      return new Set(initial?.() ?? []);
    }
  });
  const set = (next: Set<string>) => {
    setState(next);
    try {
      localStorage.setItem(key, JSON.stringify([...next]));
    } catch {
      // Без хранилища выбор живёт до закрытия приложения
    }
  };
  return [hidden, set];
}

/** Строки таблицы: крупные категории отдельно, мелкие в «Прочее». */
function categoryRows(data: IncomeCategory[]) {
  const byCategory = new Map<string, number>();
  for (const r of data) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.total);
  // Зарплаты всегда отдельно по людям; из остального крупные отдельно, мелкие в «Прочее»
  const others = [...byCategory.entries()].filter(([name]) => !isSalary(name)).sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const own = new Set(others.length > MAX_OTHER_COLUMNS + 1 ? others.slice(0, MAX_OTHER_COLUMNS).filter((c) => c !== OTHER) : others);
  return { rowOf: (category: string) => (isSalary(category) || own.has(category) ? category : OTHER) };
}

/**
 * Доходы по категориям из тегов: график и две таблицы, где строки это месяцы (свежие сверху).
 * Зарплаты по людям отдельной таблицей, во второй они одним столбцом «ЗП» рядом с остальными категориями.
 * Снятая галочка убирает категорию с графика и из итогов, и шкала перестраивается.
 */
function IncomeCategories({ base, data, hidden, onHidden }: { base: string; data: IncomeCategory[]; hidden: Set<string>; onHidden: (next: Set<string>) => void }) {
  const [tableMode, setTableMode] = useRemembered<'salaries' | 'all'>(`${base}:incomeTable`, 'salaries');
  const row = categoryRows(data).rowOf;
  const totalOf = new Map<string, number>();
  const cellOf = new Map<string, number>();
  const add = (key: string, value: number) => cellOf.set(key, (cellOf.get(key) ?? 0) + value);
  for (const r of data) {
    const c = row(r.category);
    totalOf.set(c, (totalOf.get(c) ?? 0) + r.total);
    add(`${r.ym}|${c}`, r.total);
    // Галочки влияют только на график: таблицы и итоги всегда полные
    add(`${r.ym}|*`, r.total);
    if (isSalary(c)) add(`${r.ym}|${SALARY}`, r.total);
  }
  const value = (ym: string, column: string) => cellOf.get(`${ym}|${column}`) ?? 0;
  // «Прочее» всегда последним
  const categories = [...totalOf.entries()].sort((a, b) => (a[0] === OTHER ? 1 : b[0] === OTHER ? -1 : b[1] - a[1])).map(([name]) => name);
  const salaries = categories.filter(isSalary);
  const others = categories.filter((c) => !isSalary(c));
  const months = [...new Set(data.map((r) => r.ym))].sort().reverse();
  const color = (c: string) => (c === OTHER ? '--series-6' : CATEGORY_VARS[categories.indexOf(c) % (CATEGORY_VARS.length - 1)]);

  const chartRows: { ym: string }[] = [];
  for (let ym = months.at(-1)!; ym <= months[0]; ym = shiftYm(ym, 1)) chartRows.push({ ym });
  const series: Series<{ ym: string }>[] = categories.map((c) => ({ label: c, cssVar: color(c), get: (r) => value(r.ym, c) }));

  const table = (columns: { key: string; title: string }[], totalTitle: string) => (
    <div className="table-wrap">
      <table className="compact-table income-categories">
        <thead>
          <tr><th>Месяц</th>{columns.map((c) => <th key={c.key}>{c.title}</th>)}<th>{totalTitle}</th></tr>
          {/* Сумма за все месяцы, сразу под заголовком */}
          <tr className="funds-total">
            <th scope="row">Итого</th>
            {columns.map((c) => <td key={c.key}>{full(months.reduce((s, ym) => s + value(ym, c.key), 0))}</td>)}
            <td><b>{full(months.reduce((s, ym) => s + value(ym, totalTitle === 'Всего' ? '*' : SALARY), 0))}</b></td>
          </tr>
        </thead>
        <tbody>
          {months.map((ym) => (
            <tr key={ym}>
              <th scope="row">{monthShort(ym)}</th>
              {columns.map((c) => <td key={c.key}>{full(value(ym, c.key))}</td>)}
              <td><b>{full(value(ym, totalTitle === 'Всего' ? '*' : SALARY))}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {chartRows.length > 1 && <LineChart rows={chartRows} series={series} hidden={hidden} onHidden={onHidden} label="Доходы по категориям по месяцам, те же данные в таблицах ниже" />}
      <h2>По категориям</h2>
      <p className="muted small">Категория берётся из тегов дохода: «зп …» это зарплата по людям, остальное по самому частому тегу. Галочки над графиком влияют только на график. Суммы в {symbol()}.</p>
      {salaries.length > 0 && <Segmented value={tableMode} options={[['salaries', 'Зарплаты'], ['all', 'Все доходы']]} onChange={setTableMode} />}
      {salaries.length > 0 && tableMode === 'salaries'
        ? table(salaries.map((c) => ({ key: c, title: c.slice(SALARY.length) })), 'Все ЗП')
        : table([...(salaries.length ? [{ key: SALARY, title: 'ЗП' }] : []), ...others.map((c) => ({ key: c, title: c }))], 'Всего')}
    </>
  );
}

interface MemberRow {
  ym: string;
  credit: number;
  spent: number;
  paid: number;
  /** Долг базы на конец месяца, минус это переплата */
  owed: number;
  fundSpent: number;
}

/**
 * Люди: у каждого участника расходы за свой счёт, выплаты ему и долг базы, траты из его личного фонда
 * и на что он тратил свои деньги по фондам.
 */
function MembersView({ base }: { base: string }) {
  const { data, error } = useLoad<MemberStats>(`${base}/members/stats`);
  const [picked, setPicked] = useRemembered<number | null>(`${base}:member`, null);
  const [hidden, setHidden] = useHiddenSet(`monzoid:members-hidden:${base}`);
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) return <Spinner />;
  if (!data.members.length) return <p className="muted">В базе пока нет участников.</p>;

  const person = data.members.find((m) => m.userId === picked) ?? data.members[0];
  const own = data.months.filter((r) => r.userId === person.userId);
  const rows: MemberRow[] = [];
  let owed = 0;
  if (own.length) {
    for (let ym = own[0].ym; ym <= own[own.length - 1].ym; ym = shiftYm(ym, 1)) {
      const r = own.find((x) => x.ym === ym);
      const credit = r?.credit ?? 0;
      const spent = r?.spent ?? 0;
      const paid = r?.paid ?? 0;
      owed += credit + spent - paid;
      rows.push({ ym, credit, spent, paid, owed, fundSpent: r?.fundSpent ?? 0 });
    }
  }
  const total = (get: (r: MemberRow) => number) => rows.reduce((s, r) => s + get(r), 0);
  const expenses = total((r) => r.credit + r.spent);
  const paid = total((r) => r.paid);
  const fundSpent = total((r) => r.fundSpent);
  // Свои деньги: участник платил сам, а база ему возвращала. Кто платит с карт базы, тому база не должна
  const ownMoney = rows.some((r) => r.credit || r.spent || r.paid);
  const credited = total((r) => r.credit);
  const funds = data.byFund.filter((f) => f.userId === person.userId);
  const fundsTotal = funds.reduce((s, f) => s + f.total, 0);
  const series: Series<MemberRow>[] = [
    ...(ownMoney
      ? [
          { label: 'Расходы', cssVar: '--series-2', get: (r: MemberRow) => r.credit + r.spent },
          { label: 'Выплаты', cssVar: '--series-3', get: (r: MemberRow) => r.paid },
          { label: 'Долг', cssVar: '--series-1', get: (r: MemberRow) => r.owed },
        ]
      : []),
    ...(person.fund ? [{ label: 'Личный фонд', cssVar: '--series-4', get: (r: MemberRow) => r.fundSpent }] : []),
  ];

  return (
    <>
      {data.members.length > 1 && <Segmented value={String(person.userId)} options={data.members.map((m) => [String(m.userId), memberLabel(m.name)])} onChange={(id) => setPicked(Number(id))} />}
      <div className="tiles">
        {ownMoney && (
          <>
            <div className="tile"><span>{credited > 0 ? 'Траты за свой счёт' : 'Расходы за свой счёт'}</span><strong>{money(expenses - credited)}</strong></div>
            {credited > 0 && <div className="tile"><span>Начислено</span><strong>{money(credited)}</strong><small>по плану личного фонда</small></div>}
            <div className="tile"><span>Выплачено</span><strong>{money(paid)}</strong><small>в среднем {money(paid / rows.length)} в месяц</small></div>
            <div className={`tile${credited > 0 ? '' : ' full'}`}><span>{owed < 0 ? 'Переплата' : 'Долг базы сейчас'}</span><strong className={owed > 0 ? 'negative' : undefined}>{money(Math.abs(owed))}</strong></div>
          </>
        )}
        {person.fund && (
          <div className="tile full">
            <span>{fundLabel(person.fund.name)}</span>
            <strong>{money(fundSpent)}</strong>
            <small>потрачено из личного фонда{rows.length > 0 && `, в среднем ${money(fundSpent / rows.length)} в месяц`}</small>
          </div>
        )}
      </div>
      {!ownMoney && <p className="muted small">{person.name} платит с карт базы, поэтому база ничего не должна и выплат нет.</p>}
      {!ownMoney && !person.fund && <p className="muted">Личного фонда не нашлось: назови фонд с именем человека, например «Личные: {person.name.replace(/^[^\p{L}]+/u, '')}».</p>}
      {rows.length > 1 && series.length > 0 && <LineChart rows={rows} series={series} hidden={hidden} onHidden={setHidden} label="Расходы, выплаты, долг и личный фонд по месяцам, те же данные в таблице ниже" />}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="compact-table">
            <thead>
              <tr>
                <th>Месяц</th>
                {ownMoney && <><th>Расходы</th><th>Выплачено</th><th>Долг</th></>}
                {person.fund && <th>Личный фонд</th>}
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.ym}>
                  <th scope="row">{monthShort(r.ym)}</th>
                  {ownMoney && (
                    <>
                      <td>{cell(r.credit + r.spent)}</td>
                      <td>{cell(r.paid)}</td>
                      <td className={r.owed > 0 ? 'negative' : r.owed < 0 ? 'positive' : undefined}><b>{cell(r.owed)}</b></td>
                    </>
                  )}
                  {person.fund && <td>{cell(r.fundSpent)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Итого</th>
                {ownMoney && <><td>{cell(expenses)}</td><td>{cell(paid)}</td><td><b>{cell(owed)}</b></td></>}
                {person.fund && <td>{cell(fundSpent)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {ownMoney && <p className="muted small">Расходы это траты участника своими деньгами вместе с начислениями. Долг на конец месяца: расходы минус выплаты, накопительно. Минус означает переплату.</p>}
      {funds.length > 0 && (
        <>
          <h2>На что тратит свои деньги</h2>
          <p className="muted small">Расходы, которые {person.name} оплачивал(а) сам(а), по фондам за всё время. Начисления сюда не входят.</p>
          <div className="table-wrap">
            <table className="compact-table">
              <thead><tr><th>Фонд</th><th>Сумма</th><th>Доля</th><th>Операций</th></tr></thead>
              <tbody>
                {funds.map((f) => (
                  <tr key={f.fundId}>
                    <th scope="row">{fundLabel(f.fundName)}</th>
                    <td>{cell(f.total)}</td>
                    <td>{fundsTotal ? Math.round((f.total / fundsTotal) * 100) : 0}%</td>
                    <td>{f.count}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><th scope="row">Итого</th><td><b>{cell(fundsTotal)}</b></td><td /><td>{funds.reduce((s, f) => s + f.count, 0)}</td></tr></tfoot>
            </table>
          </div>
        </>
      )}
    </>
  );
}

type FundsMode = 'balance' | 'spent' | 'planned';
// Сколько фондов показано на графике, пока человек сам не выбрал
const FUNDS_SHOWN = 5;

// Порог единичного выброса плана: 15 000 в сотых долях
const PLAN_SPIKE = 1_500_000;

/**
 * Месяцы, где план фонда выбивается разово: выше обоих соседних месяцев или ниже обоих хотя бы на порог.
 * Ступенька, после которой план так и остаётся, не выброс. Месяцы по возрастанию.
 */
function planSpikes(plans: (number | null)[]): Set<number> {
  const result = new Set<number>();
  for (let i = 1; i < plans.length - 1; i++) {
    const [prev, p, next] = [plans[i - 1], plans[i], plans[i + 1]];
    if (p === null || prev === null || next === null) continue;
    if (Math.min(p - prev, p - next) >= PLAN_SPIKE || Math.min(prev - p, next - p) >= PLAN_SPIKE) result.add(i);
  }
  return result;
}

function FundsTable({ base, months: closedMonths, currentYm, mode, onOpen }: { base: string; months: MonthReport[]; currentYm: string; mode: FundsMode; onOpen: (id: number) => void }) {
  // Текущий незакрытый месяц последним столбцом «сейчас»: с полным планом месяца, то есть наибольшим значением к его концу
  const openYm = closedMonths.at(-1)!.ym === shiftYm(currentYm, -1) ? currentYm : null;
  const { data: now } = useLoad<Summary>(openYm ? `${base}/summary?ym=${openYm}` : null);
  // В текущем месяце остаток считается с планом по прожитым дням, как в «Капитале»
  const unlived = openYm ? 1 - planShare(openYm) : 0;
  const live = now && openYm
    ? { ...now.report, fundsAfter: now.report.fundsAfter - Math.round(now.report.plannedTotal * unlived), funds: now.report.funds.map((f) => ({ ...f, balanceAfter: f.balanceAfter - Math.round(f.planned * unlived) })) }
    : null;
  const months = live ? [...closedMonths, live] : closedMonths;
  const funds = [...new Map(months.flatMap((m) => m.funds).map((f) => [f.id, f.name])).entries()];
  const ordered = [...months].reverse();
  // Остатки окрашиваются по знаку, факт и план это просто суммы
  const total = (m: MonthReport) => (mode === 'balance' ? m.fundsAfter : mode === 'spent' ? m.spentTotal : m.plannedTotal);
  const value = (f: MonthReport['funds'][number]) => (mode === 'balance' ? f.balanceAfter : mode === 'spent' ? f.spent : f.planned);
  const toneOf = (x: number) => (mode === 'balance' ? tone(x) : '');
  // На графике сначала только самые крупные по остатку фонды: все сразу сливаются в кашу
  const last = months[months.length - 1];
  const [hidden, setHidden] = useHiddenSet(`monzoid:funds-hidden:${base}`, () =>
    [...last.funds].sort((a, b) => Math.abs(b.balanceAfter) - Math.abs(a.balanceAfter)).slice(FUNDS_SHOWN).map((f) => f.name));
  // Цвета раздаются показанным линиям по порядку, чтобы они не повторялись
  let shown = 0;
  const series: Series<MonthReport>[] = funds.map(([id, name]) => ({
    label: name,
    cssVar: hidden.has(name) ? '--muted' : CATEGORY_VARS[shown++ % CATEGORY_VARS.length],
    get: (m) => { const f = m.funds.find((x) => x.id === id); return f ? value(f) : 0; },
  }));
  return (
    <>
      {months.length > 1 && <LineChart rows={months} series={series} hidden={hidden} label="Фонды по месяцам: остатки, траты или планы, как выбрано выше; галочки у фондов в таблице ниже" />}
      <div className="table-wrap">
        <table className="compact-table funds-table">
          <thead>
            <tr><th>Фонд, {symbol()}</th>{ordered.map((m) => <th key={m.ym}>{m.closed ? monthShort(m.ym) : <>сейчас<br /><small className="muted">{monthShort(m.ym)}</small></>}</th>)}</tr>
            {/* Сумма по всем фондам за месяц, сразу под месяцами */}
            <tr className="funds-total">
              <th scope="row">
                <span className="fund-row-title">
                  <input
                    type="checkbox"
                    aria-label="Показать на графике все фонды"
                    checked={hidden.size === 0}
                    ref={(el) => { if (el) el.indeterminate = hidden.size > 0 && hidden.size < funds.length; }}
                    onChange={() => setHidden(hidden.size === 0 ? new Set(funds.map(([, n]) => n)) : new Set())}
                  />
                  Все фонды
                </span>
              </th>
              {ordered.map((m) => <td key={m.ym} className={toneOf(total(m))}><b>{cell(total(m))}</b></td>)}
            </tr>
          </thead>
          <tbody>
            {funds.map(([id, name]) => (
              <tr key={id}>
                <th scope="row">
                  <span className="fund-row-title">
                    <input
                      type="checkbox"
                      aria-label={`Показать на графике: ${name}`}
                      checked={!hidden.has(name)}
                      onChange={() => {
                        const next = new Set(hidden);
                        if (next.has(name)) next.delete(name);
                        else next.add(name);
                        setHidden(next);
                      }}
                      style={{ accentColor: `var(${series.find((s) => s.label === name)!.cssVar})` }}
                    />
                    <button type="button" className="cell-button" onClick={() => onOpen(id)}>{fundLabel(name).replace(' ', ' ')}</button>
                  </span>
                </th>
                {(() => {
                  const spikes = mode === 'planned' ? planSpikes(months.map((m) => m.funds.find((x) => x.id === id)?.planned ?? null)) : new Set<number>();
                  return ordered.map((m, j) => {
                    const f = m.funds.find((x) => x.id === id);
                    const spike = spikes.has(months.length - 1 - j);
                    return <td key={m.ym} className={spike ? 'negative' : f ? toneOf(value(f)) : ''} title={spike ? 'План выбивается из соседних месяцев' : undefined}>{f ? cell(value(f)) : '—'}</td>;
                  });
                })()}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FundDetail({ months, fundId }: { months: MonthReport[]; fundId: number }) {
  let balance = 0;
  const rows = months.map((m) => {
    const f = m.funds.find((x) => x.id === fundId);
    balance = f?.balanceAfter ?? balance;
    return { ym: m.ym, planned: f?.planned ?? 0, spent: f?.spent ?? 0, delta: f?.delta ?? 0, balance };
  });
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0);
  const spikes = planSpikes(rows.map((r) => r.planned));
  const peak = rows.reduce((a, b) => (b.spent > a.spent ? b : a));

  return (
    <>
      <div className="tiles">
        <div className="tile"><span>Накоплено</span><strong>{money(balance)}</strong></div>
        <div className="tile"><span>В среднем за месяц</span><strong>{money(totalSpent / rows.length)}</strong></div>
        <div className="tile"><span>Потрачено всего</span><strong>{money(totalSpent)}</strong></div>
        <div className="tile"><span>Самый дорогой месяц</span><strong>{money(peak.spent)}</strong><small>{monthName(peak.ym)}</small></div>
      </div>
      {rows.length > 1 && (
        <>
          <LineChart
            rows={rows}
            title="План и факт за месяц"
            label="План и факт фонда по месяцам, те же данные в таблице ниже"
            series={[
              { label: 'Факт', cssVar: '--series-1', get: (r) => r.spent },
              { label: 'План', cssVar: '--series-2', get: (r) => r.planned },
            ]}
          />
          <LineChart rows={rows} title="Накоплено в фонде" label="Накопленный остаток фонда по месяцам, те же данные в таблице ниже" series={[{ label: 'Накоплено', cssVar: '--series-3', get: (r) => r.balance }]} />
        </>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Месяц</th><th>План</th><th>Факт</th><th>Накоплено</th></tr></thead>
          <tbody>
            {[...rows].reverse().map((r, j) => (
              <tr key={r.ym}>
                <th scope="row">{monthShort(r.ym)}</th>
                <td className={spikes.has(rows.length - 1 - j) ? 'negative' : ''}>{cell(r.planned)}</td>
                <td>{cell(r.spent)}</td>
                <ValueCell value={r.balance} delta={r.delta} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

type Period = 'all' | '12' | '3';

function TagsView({ base }: { base: string }) {
  const { data, error } = useLoad<TagStats>(`${base}/tags/stats`);
  const [period, setPeriod] = useState<Period>('all');
  const [tagId, setTagId] = useState<number | null>(null);
  useBack(tagId !== null, 2, () => setTagId(null));

  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) return <Spinner />;
  if (!data.rows.length) return <p className="muted">Здесь появятся суммы по тегам, когда у расходов будут теги.</p>;

  if (tagId !== null) return <TagDetail stats={data} tagId={tagId} onBack={() => setTagId(null)} />;

  const from = period === 'all' ? '' : shiftYm(data.currentYm, -Number(period) + 1);
  const totals = new Map<number, { id: number; name: string; total: number; count: number }>();
  for (const r of data.rows) {
    if (r.ym < from) continue;
    const t = totals.get(r.tagId) ?? { id: r.tagId, name: r.name, total: 0, count: 0 };
    t.total += r.total;
    t.count += r.count;
    totals.set(r.tagId, t);
  }
  const list = [...totals.values()].sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...list.map((t) => t.total));
  const untagged = data.untagged.filter((u) => u.ym >= from).reduce((s, u) => s + u.total, 0);

  return (
    <>
      <Segmented value={period} options={[['all', 'Всё время'], ['12', '12 месяцев'], ['3', '3 месяца']]} onChange={setPeriod} />
      {list.length === 0 && <p className="muted">За этот период расходов с тегами нет.</p>}
      <ul className="tag-rank">
        {list.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => setTagId(t.id)}>
              <div className="fund-top"><span className="entry-title">#{t.name}</span><b>{money(t.total)}</b></div>
              <div className="bar"><i style={{ width: `${Math.max(0, (t.total / max) * 100)}%` }} /></div>
              <div className="muted small">Операций: {t.count}</div>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">Без тегов: {money(untagged)}. Операция с несколькими тегами считается в каждом из них, поэтому суммы тегов нельзя складывать.</p>
    </>
  );
}

function TagDetail({ stats, tagId, onBack }: { stats: TagStats; tagId: number; onBack: () => void }) {
  const own = stats.rows.filter((r) => r.tagId === tagId);
  // Месяцы без расходов тоже показываются: иначе график соединит соседние точки и скроет провал
  const rows: { ym: string; total: number; count: number }[] = [];
  for (let ym = own[0].ym; ym <= own[own.length - 1].ym; ym = shiftYm(ym, 1)) {
    const r = own.find((x) => x.ym === ym);
    rows.push({ ym, total: r?.total ?? 0, count: r?.count ?? 0 });
  }
  const total = rows.reduce((s, r) => s + r.total, 0);
  const count = rows.reduce((s, r) => s + r.count, 0);

  return (
    <>
      <Header title={`#${own[0].name}`} onBack={onBack} />
      <div className="tiles">
        <div className="tile"><span>Потрачено всего</span><strong>{money(total)}</strong><small>Операций: {count}</small></div>
        <div className="tile"><span>В среднем за месяц</span><strong>{money(total / rows.length)}</strong></div>
      </div>
      {rows.length > 1 && <LineChart rows={rows} label={`Расходы с тегом ${own[0].name} по месяцам, те же данные в таблице ниже`} series={[{ label: 'Расходы', cssVar: '--series-1', get: (r) => r.total }]} />}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Месяц</th><th>Расходы</th><th>Операций</th></tr></thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.ym}><th scope="row">{monthShort(r.ym)}</th><td>{cell(r.total)}</td><td>{r.count}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
