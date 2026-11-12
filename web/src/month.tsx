import { useEffect, useState } from 'react';
import { api, confirmAction, useLoad, type Entry, type PaceAlert, type Summary, type TagStats } from './api';
import { leaveForm, useUnsaved } from './back';
import { numberInput, dayMonth, fundLabel, memberLabel, money as exactMoney, moneyRounded as money, monthName, parseMoney, planShare, shiftYm, signed as exactSigned, signedRounded as signed, toInput, tone } from './format';
import { StatementQueue } from './imports';
import { Banner, Button, Header, MonthNav, Spinner } from './ui';

function paceText(a: PaceAlert): string {
  const share = Math.round((a.spent / a.planned) * 100);
  const forecast = a.runOutDay === null ? 'лимит уже исчерпан' : `в таком темпе лимит кончится примерно ${a.runOutDay} числа`;
  return `к ${a.day} числу (${a.checkpoint}% месяца) потрачено ${share}% лимита, ${forecast}`;
}

export function PaceBanner({ alerts }: { alerts: PaceAlert[] }) {
  if (!alerts.length) return null;
  return (
    <Banner kind="warn">
      <b>Тратится быстрее нормы</b>
      <ul className="pace-list">
        {alerts.map((a) => <li key={a.fundId}>{a.name}: {paceText(a)}</li>)}
      </ul>
    </Banner>
  );
}

export function MonthScreen({ base, ledgerName, userId, ym, currentYm, onYm, onFund, onPlan, onImport, onSettle }: {
  base: string;
  userId: number;
  ledgerName: string;
  ym: string;
  currentYm: string;
  onYm: (ym: string) => void;
  onFund: (id: number) => void;
  onPlan: () => void;
  onImport: (batchId?: number) => void;
  onSettle: () => void;
}) {
  const { data, error, reload } = useLoad<Summary>(`${base}/summary?ym=${ym}`);
  const { data: imports } = useLoad<{ id: number; pending: number; files: string[] }[]>(`${base}/imports`);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) return <Spinner />;
  const { report, isAdmin, startYm, lastClosed, debts } = data;
  const canClose = isAdmin && !report.closed && (lastClosed ? shiftYm(lastClosed, 1) === ym : startYm === ym);
  const canReopen = isAdmin && report.closed && lastClosed === ym;
  // Итоги в плашках есть только у закрытого месяца: у открытого они ещё меняются
  const totals = report.closed ? report : null;
  const hasAssets = !!totals && (totals.assetsAfter !== 0 || totals.assetsInvested !== 0);
  const during = 'за месяц';
  // Месяцы закрываются только вручную: после 1 числа напоминаем про прошлый незакрытый
  const toClose = lastClosed ? shiftYm(lastClosed, 1) : startYm;
  const remindClose = isAdmin && toClose < currentYm;
  const fundsShown = report.funds.filter((f) => f.planned || f.spent);
  // В открытом месяце план входит в фонд по дням: в остатке только прожитая часть плана
  const unlived = report.closed ? 0 : 1 - planShare(ym);
  const inFund = (f: { balanceAfter: number; planned: number }) => f.balanceAfter - Math.round(f.planned * unlived);
  const notPlanned = report.funds.filter((f) => !f.planned && !f.spent);
  const left = report.plannedTotal - report.spentTotal;
  const saved = report.income - report.spentTotal - (report.assetCosts ?? 0);

  // Календарный месяц прошёл, а этот ещё открыт: закрыть и поправить план нужно сейчас, кнопки наверху
  const actionsOnTop = !report.closed && ym < currentYm;
  const monthActions = isAdmin && (
    <div className="stack">
      {!report.closed && <Button onClick={onPlan}>Править план месяца</Button>}
      {canClose && (
        <Button primary={actionsOnTop} onClick={() => act('close', `Закрыть ${monthName(ym)}? Свободные средства: ${signed(report.freeDelta)}, фонды: ${signed(report.fundsDelta)}. Операции этого месяца нельзя будет менять, пока он не открыт заново.`)}>
          Закрыть месяц
        </Button>
      )}
      {canReopen && <Button onClick={() => act('reopen', `Открыть ${monthName(ym)} заново?`)}>Открыть месяц заново</Button>}
    </div>
  );

  async function act(path: string, question: string) {
    if (!(await confirmAction(question))) return;
    try {
      await api.post(`${base}/months/${ym}/${path}`);
      setActionError(null);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <>
      <p className="ledger-name">{ledgerName}</p>
      <MonthNav ym={ym} onYm={onYm} min={startYm} max={currentYm} />
      {report.closed && <Banner>Месяц закрыт, суммы зафиксированы.</Banner>}
      {remindClose && (
        <Banner kind="warn">
          <b>Закройте {monthName(toClose).toLowerCase()}</b>
          <div className="small">Когда все расходы и доходы за месяц внесены, закройте его: итоги зафиксируются, а остатки фондов перейдут в следующий месяц.</div>
          {ym !== toClose && <div className="stack"><Button small onClick={() => onYm(toClose)}>Перейти к месяцу</Button></div>}
        </Banner>
      )}
      {actionError && <Banner kind="error">{actionError}</Banner>}
      {actionsOnTop && monthActions}

      {totals && (
        <div className="tiles">
          <div className="tile hero">
            <span>Свободные средства</span>
            <strong>{money(totals.freeAfter)}</strong>
            <small>{during} <span className={tone(totals.freeDelta)}>{signed(totals.freeDelta)}</span></small>
          </div>
          <div className="tile">
            <span>Фонды</span>
            <strong>{money(totals.fundsAfter)}</strong>
            <small>{during} <span className={tone(totals.fundsDelta)}>{signed(totals.fundsDelta)}</span></small>
          </div>
          <div className="tile">
            <span>Вклады</span>
            <strong>{money(totals.potsAfter)}</strong>
            <small>вложено {money(totals.potsInvested)}</small>
          </div>
          {hasAssets && (
            <div className="tile">
              <span>Активы</span>
              <strong>{money(totals.assetsAfter)}</strong>
              <small>недвижимость, машины</small>
            </div>
          )}
          <div className={`tile${hasAssets ? '' : ' full'}`}>
            <span>Всего накоплено</span>
            <strong>{money(totals.totalAfter)}</strong>
            <small>деньги {money(totals.moneyAfter)} · вклады {money(totals.potsAfter)}{hasAssets && <> · активы {money(totals.assetsAfter)}</>}</small>
          </div>
        </div>
      )}

      <dl className="facts">
        <div><dt>Доходы</dt><dd>{money(report.income)}</dd></div>
        <div><dt>План расходов</dt><dd>{unlived > 0 && unlived < 1 && <>{money(report.plannedTotal - Math.round(report.plannedTotal * unlived))}<span className="muted"> / </span></>}{money(report.plannedTotal)}</dd></div>
        <div><dt>Потрачено</dt><dd>{money(report.spentTotal)}{report.plannedTotal > 0 && <span className="muted"> · {Math.round((report.spentTotal / report.plannedTotal) * 100)}% плана</span>}</dd></div>
        {report.plannedTotal > 0 && (
          <div><dt>{left >= 0 ? 'Осталось по плану' : 'Перерасход плана'}</dt><dd className={left >= 0 ? '' : tone(left)}>{money(Math.abs(left))}</dd></div>
        )}
        <div><dt>Доходы минус расходы</dt><dd className={tone(saved)}>{signed(saved)}</dd></div>
        {report.adjustments !== 0 && <div><dt>Корректировки</dt><dd>{signed(report.adjustments)}</dd></div>}
        {report.transfers !== 0 && <div><dt>Переносы в свободные</dt><dd>{signed(report.transfers)}</dd></div>}
        {report.potMoves !== 0 && <div><dt>Во вклады</dt><dd>{money(report.potMoves)}</dd></div>}
        {report.assetCosts > 0 && <div><dt>Расходы по активам</dt><dd>{money(report.assetCosts)}</dd></div>}
        {report.assetMoves > 0 && <div><dt>Покупка активов</dt><dd>{money(report.assetMoves)}</dd></div>}
        {report.assetMoves < 0 && <div><dt>Продажа активов</dt><dd>{money(-report.assetMoves)}</dd></div>}
      </dl>

      {imports?.map((b) => (
        <button key={b.id} className="banner warn as-button" onClick={() => onImport(b.id)}>
          Выписка ждёт проверки: {b.pending} операций. Продолжить ›
        </button>
      ))}

      <StatementQueue base={base} userId={userId} onImport={onImport} />

      {!report.closed && <Button primary onClick={() => onImport()}>Загрузить выписку</Button>}

      {debts.filter((d) => d.owed !== 0 || (d.credited && d.settledUntil)).map((d) => (
        <button key={d.userId} className="banner info as-button" onClick={onSettle}>
          {d.owed > 0 ? <>База должна участнику {memberLabel(d.name)}: <b>{exactMoney(d.owed)}</b></> : d.owed < 0 ? <>Переплата участнику {memberLabel(d.name)}: <b>{exactMoney(-d.owed)}</b></> : <>Расчёт с участником {memberLabel(d.name)} закрыт</>}
          {d.settledUntil && <> · расчёт по {dayMonth(d.settledUntil)}</>} ›
        </button>
      ))}

      <PaceBanner alerts={data.paceAlerts} />

      <h2>Фонды</h2>
      {fundsShown.length === 0 && (
        <p className="muted">В этом месяце ещё нет плана. {isAdmin ? 'Задай лимиты по фондам.' : 'Его задаёт администратор.'}</p>
      )}
      <ul className="fund-list">
        {fundsShown.map((f) => {
          const share = f.planned > 0 ? Math.min(f.spent / f.planned, 1) : f.spent > 0 ? 1 : 0;          return (
            <li key={f.id}>
              <button onClick={() => onFund(f.id)}>
                <div className="fund-top">
                  <span>{fundLabel(f.name)}</span>
                  <b className={tone(f.delta)}>{money(f.delta)}</b>
                </div>
                <div className="bar" aria-hidden><i className={f.delta < 0 ? 'over' : ''} style={{ width: `${Math.max(share * 100, 0)}%` }} /></div>
                <div className="fund-bottom muted">
                  <span>{money(f.spent)} из {money(f.planned)}</span>
                  <span>в фонде <span className={tone(inFund(f))}>{money(inFund(f))}</span></span>
                </div>
                {data.paceAlerts.some((a) => a.fundId === f.id) && <div className="pace-note">⚠ Тратится быстрее нормы</div>}
              </button>
            </li>
          );
        })}
      </ul>
      {notPlanned.length > 0 && <p className="muted small">Без плана и расходов: {notPlanned.map((f) => fundLabel(f.name)).join(', ')}</p>}

      <MonthExtras base={base} ym={ym} />

      {!actionsOnTop && monthActions}
    </>
  );
}

const TOP_ENTRIES = 5;

/** Теги месяца и самые крупные траты (раньше были на отдельной вкладке статистики). */
function MonthExtras({ base, ym }: { base: string; ym: string }) {
  const { data: entries } = useLoad<Entry[]>(`${base}/entries?ym=${ym}`);
  const { data: tags } = useLoad<TagStats>(`${base}/tags/stats`);
  const monthTags = (tags?.rows ?? []).filter((r) => r.ym === ym && r.total > 0).sort((a, b) => b.total - a.total);
  const biggest = (entries ?? []).filter((e) => e.kind === 'expense' && e.amount > 0 && !e.autoCredit).sort((a, b) => b.amount - a.amount).slice(0, TOP_ENTRIES);
  return (
    <>
      {biggest.length > 0 && (
        <>
          <h2>Самые крупные траты</h2>
          <dl className="facts">
            {biggest.map((e) => <div key={e.id}><dt>{dayMonth(e.date)} · {e.comment || e.description || fundLabel(e.fundName)}</dt><dd>{money(e.amount)}</dd></div>)}
          </dl>
        </>
      )}
      {monthTags.length > 0 && (
        <>
          <h2>По тегам</h2>
          <dl className="facts">
            {monthTags.map((t) => <div key={t.tagId}><dt>#{t.name}</dt><dd>{money(t.total)}</dd></div>)}
          </dl>
        </>
      )}
    </>
  );
}

export function PlanScreen({ base, ym, onClose }: { base: string; ym: string; onClose: () => void }) {
  const { data } = useLoad<Summary>(`${base}/summary?ym=${ym}`);
  const { data: funds } = useLoad<{ id: number; name: string; archived: number }[]>(`${base}/funds`);
  const [values, setValues] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data || !funds) return;
    const planned = new Map(data.report.funds.map((f) => [f.id, f.planned]));
    setValues(Object.fromEntries(funds.map((f) => [f.id, toInput(planned.get(f.id) ?? 0)])));
  }, [data, funds]);

  const plannedNow = new Map(data?.report.funds.map((f) => [f.id, f.planned]));
  const planChanged = !!funds?.some((f) => !f.archived && values[f.id] !== undefined && values[f.id] !== toInput(plannedNow.get(f.id) ?? 0));
  useUnsaved(planChanged);

  if (!data || !funds) return <div className="screen"><Spinner /></div>;
  const active = funds.filter((f) => !f.archived);
  const total = active.reduce((s, f) => s + (parseMoney(values[f.id] ?? '') ?? 0), 0);

  async function save() {
    const items = [];
    for (const f of active) {
      const text = (values[f.id] ?? '').trim();
      const amount = text === '' ? 0 : parseMoney(text);
      if (amount === null || amount < 0) return setError(`Проверь сумму в фонде «${f.name}»`);
      items.push({ fundId: f.id, amount });
    }
    try {
      await api.put(`${base}/plans/${ym}`, { items });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="screen with-footer">
      <Header title={`План: ${monthName(ym)}`} onBack={() => leaveForm(onClose)} />
      {error && <Banner kind="error">{error}</Banner>}
      <ul className="plan-list">
        {active.map((f) => (
          <li key={f.id}>
            <label htmlFor={`plan-${f.id}`}>{fundLabel(f.name)}</label>
            <input id={`plan-${f.id}`} inputMode="decimal" placeholder="0" value={values[f.id] ?? ''} onChange={(e) => setValues({ ...values, [f.id]: numberInput(e.target.value, { minus: true }) })} />
          </li>
        ))}
      </ul>
      <div className="footer-bar">
        <div>
          <div>План: <b>{exactMoney(total)}</b></div>
          <small className="muted">Доходы минус план: {exactSigned(data.report.income - total)}</small>
        </div>
        <Button primary onClick={save}>Сохранить</Button>
      </div>
    </div>
  );
}
