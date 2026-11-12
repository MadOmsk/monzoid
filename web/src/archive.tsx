import { useState } from 'react';
import { api, confirmAction, useLoad, withRecalc, type Fund } from './api';
import { useBack } from './back';
import { dayMonth, fundLabel, money, numberInput, parseMoney, signed, today } from './format';
import { Banner, Button, DateInput, Field, Segmented, Spinner } from './ui';

interface Preview {
  name: string;
  personal: boolean;
  balance: number;
  futurePlan: number;
  entries: { id: number; date: string; amount: number; comment: string; description: string; closed: boolean }[];
  closedEntries: number;
  empty: boolean;
}

type Mode = 'keep' | 'move' | 'split';
const FREE = '';

/** Куда ушло при архивации: подпись у архивного фонда в списке. */
export function archiveNote(f: Fund): string {
  const a = f.archive;
  if (!a) return 'в архиве';
  const when = `в архиве с ${dayMonth(a.date, true)}`;
  if (a.mode === 'move') return `${when} · операции перенесены в «${a.targetName}»`;
  if (a.mode === 'split') return `${when} · операции разнесены по фондам`;
  return `${when} · остаток ${a.balanceToName ? `в «${a.balanceToName}»` : 'в свободные'}`;
}

/**
 * Архивация фонда: что у него есть и куда деть операции и остаток. Пустой фонд архивируется сразу.
 * Всё, что сделано, отменяется кнопкой «Вернуть» в списке фондов.
 */
export function ArchiveFund({ base, fund, funds, onDone, onBack }: { base: string; fund: Fund; funds: Fund[]; onDone: () => Promise<void>; onBack: () => void }) {
  const { data, error: loadError } = useLoad<Preview>(`${base}/funds/${fund.id}/archive`);
  const others = funds.filter((f) => !f.archived && f.id !== fund.id);
  const [mode, setMode] = useState<Mode>('keep');
  const [target, setTarget] = useState<number | ''>('');
  const [balanceTo, setBalanceTo] = useState<string>(FREE);
  const [assign, setAssign] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  useBack(true, 2, onBack);

  if (loadError) return <><Banner kind="error">{loadError}</Banner><Button onClick={onBack}>Назад</Button></>;
  if (!data) return <Spinner />;

  async function archive() {
    if (mode !== 'keep' && target === '') return setError(mode === 'move' ? 'Выбери фонд, куда перенести операции.' : 'Выбери фонд по умолчанию.');
    const body = {
      mode,
      targetFundId: target === '' ? null : target,
      balanceToFundId: balanceTo === FREE ? null : Number(balanceTo),
      assignments: Object.entries(assign).map(([entryId, fundId]) => ({ entryId: Number(entryId), fundId })),
    };
    try {
      if ((await withRecalc((recalc) => api.post(`${base}/funds/${fund.id}/archive`, { ...body, recalc }))) === null) return;
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const fundOptions = others.map((f) => <option key={f.id} value={f.id}>{fundLabel(f.name)}</option>);
  const balanceSelect = data.balance !== 0 && (
    <Field label={data.balance > 0 ? 'Остаток отдать' : 'Перерасход покрыть из'}>
      <select value={balanceTo} onChange={(e) => setBalanceTo(e.target.value)}>
        <option value={FREE}>Свободные средства</option>
        {fundOptions}
      </select>
    </Field>
  );

  if (data.personal) {
    return (
      <>
        <h2>В архив: {fundLabel(fund.name)}</h2>
        <Banner kind="warn">Это личный фонд участника. Сначала сними его в карточке участника: «База → Участники».</Banner>
        <Button onClick={onBack}>Назад</Button>
      </>
    );
  }

  return (
    <>
      {/* Экран внутри страницы «Фонды»: у неё уже есть заголовок с кнопкой назад */}
      <h2>В архив: {fundLabel(fund.name)}</h2>
      {error && <Banner kind="error">{error}</Banner>}
      <dl className="facts">
        <div><dt>Остаток сейчас</dt><dd>{signed(data.balance)}</dd></div>
        <div><dt>Операций</dt><dd>{data.entries.length}{data.closedEntries > 0 && <span className="muted"> · в закрытых месяцах {data.closedEntries}</span>}</dd></div>
        {data.futurePlan !== 0 && <div><dt>План с этого месяца</dt><dd>{money(data.futurePlan)}</dd></div>}
      </dl>
      {data.empty ? (
        <p className="muted small">У фонда нет операций и плана: он просто уйдёт в архив.</p>
      ) : (
        <>
          <Segmented<Mode> value={mode} options={[['keep', 'Оставить'], ['move', 'Перенести'], ['split', 'Разнести']]} onChange={setMode} />
          {mode === 'keep' && (
            <>
              <p className="muted small">Операции остаются в архивном фонде, история и статистика не меняются. План с этого месяца снимается, остаток переносится записью «перенос остатка».</p>
              {balanceSelect}
            </>
          )}
          {mode === 'move' && (
            <>
              <p className="muted small">Все операции, планы по месяцам и стартовый остаток переезжают в выбранный фонд. Свободные средства не меняются ни в одном месяце, меняются только остатки двух фондов.</p>
              <Field label="Куда">
                <select value={target} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Выбери фонд</option>
                  {fundOptions}
                </select>
              </Field>
            </>
          )}
          {mode === 'split' && (
            <>
              <p className="muted small">У каждой операции свой фонд. План месяца переезжает вслед за операциями, поэтому остатки фондов-получателей не меняются. Что останется в фонде, переносится отдельно.</p>
              <Field label="Фонд по умолчанию">
                <select value={target} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Выбери фонд</option>
                  {fundOptions}
                </select>
              </Field>
              {balanceSelect}
              <ul className="simple-list archive-entries">
                {data.entries.map((e) => (
                  <li key={e.id}>
                    <span>
                      {e.comment || e.description || '—'}
                      <small className="muted"> · {dayMonth(e.date, true)} · {money(e.amount)}</small>
                    </span>
                    <select aria-label={`Фонд для операции ${e.comment}`} value={assign[e.id] ?? ''} onChange={(ev) => {
                      const next = { ...assign };
                      if (ev.target.value) next[e.id] = Number(ev.target.value);
                      else delete next[e.id];
                      setAssign(next);
                    }}>
                      <option value="">как по умолчанию</option>
                      {fundOptions}
                    </select>
                  </li>
                ))}
              </ul>
            </>
          )}
          {data.closedEntries > 0 && mode !== 'keep' && <p className="muted small">Задеты закрытые месяцы: их итоги пересчитаются, перенос операций попадёт в журнал изменений.</p>}
        </>
      )}
      <Button primary onClick={archive}>В архив</Button>
      <Button onClick={onBack}>Отмена</Button>
      <p className="muted small">Отменить можно кнопкой ↺ у фонда в списке: всё вернётся как было, кроме того, что потом поменяли руками.</p>
    </>
  );
}

/** Возврат фонда из архива: отменяет всё, что сделала архивация. */
export async function restoreFund(base: string, fund: Fund): Promise<string | null> {
  if (!(await confirmAction(`Вернуть «${fund.name}» из архива? Операции, планы и остаток вернутся как были до архивации.`))) return null;
  const res = await withRecalc((recalc) => api.post<{ skipped: number }>(`${base}/funds/${fund.id}/restore`, { recalc }));
  if (res === null) return null;
  return res.skipped ? `Фонд возвращён. Операций, которые потом меняли руками, не тронуто: ${res.skipped}.` : 'Фонд возвращён.';
}

interface Transfer {
  id: number;
  date: string;
  amount: number;
  comment: string;
  fromFundId: number | null;
  toFundId: number | null;
  fromName: string | null;
  toName: string | null;
  archiveId: number | null;
  closed: boolean;
}

/** Переносы остатков: между фондами и свободными, «Деньги» не меняют. */
export function TransfersView({ base }: { base: string }) {
  const { data, error, reload } = useLoad<Transfer[]>(`${base}/transfers`);
  const { data: funds } = useLoad<Fund[]>(`${base}/funds`);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>(FREE);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [comment, setComment] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const active = funds?.filter((f) => !f.archived) ?? [];
  const side = (id: number | null, name: string | null) => (id === null ? 'Свободные' : fundLabel(name ?? '?'));
  const options = (
    <>
      <option value={FREE}>Свободные средства</option>
      {active.map((f) => <option key={f.id} value={f.id}>{fundLabel(f.name)}</option>)}
    </>
  );

  async function add() {
    const value = parseMoney(amount);
    if (!value || value <= 0) return setMessage('Введи сумму больше нуля.');
    if (from === to) return setMessage('Откуда и куда должны различаться.');
    try {
      const body = { date, amount: value, fromFundId: from === FREE ? null : Number(from), toFundId: to === FREE ? null : Number(to), comment };
      if ((await withRecalc((recalc) => api.post(`${base}/transfers`, { ...body, recalc }))) === null) return;
      setAmount('');
      setComment('');
      setMessage(null);
      await reload();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }

  async function remove(t: Transfer) {
    if (!(await confirmAction('Удалить перенос?'))) return;
    try {
      if ((await withRecalc((recalc) => api.del(`${base}/transfers/${t.id}${recalc ? '?recalc=1' : ''}`))) === null) return;
      await reload();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }

  return (
    <>
      <p className="muted small">Перенос перекладывает накопленное между фондами или между фондом и свободными средствами. «Деньги» не меняются, план и траты тоже.</p>
      {message && <Banner kind="error">{message}</Banner>}
      <div className="range-row">
        <Field label="Откуда"><select value={from} onChange={(e) => setFrom(e.target.value)}>{options}</select></Field>
        <Field label="Куда"><select value={to} onChange={(e) => setTo(e.target.value)}>{options}</select></Field>
      </div>
      <div className="range-row">
        <Field label="Сумма"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(numberInput(e.target.value))} /></Field>
        <Field label="Дата"><DateInput value={date} onChange={setDate} /></Field>
      </div>
      <Field label="Комментарий"><input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} /></Field>
      <Button primary onClick={add}>Перенести</Button>
      {error && <Banner kind="error">{error}</Banner>}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <p className="muted">Переносов пока нет.</p>}
      <ul className="simple-list">
        {data?.map((t) => (
          <li key={t.id}>
            <span>
              {side(t.fromFundId, t.fromName)} → {side(t.toFundId, t.toName)}
              <small className="muted"> · {dayMonth(t.date, true)}{t.closed && ' · закрыт'}{t.comment && ` · ${t.comment}`}</small>
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>
              {money(t.amount)}{' '}
              {!t.archiveId && <button className="icon" aria-label="Удалить перенос" onClick={() => remove(t)}>×</button>}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
