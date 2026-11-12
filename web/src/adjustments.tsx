import { useRef, useState } from 'react';
import { api, confirmAction, useLoad, withRecalc, type Adjustment, type Tag } from './api';
import { leaveForm, useBack, useUnsaved } from './back';
import { dayMonth, numberInput, parseMoney, signed, signedCell, symbol, today, toInput, tone } from './format';
import { TagPicker } from './tags';
import { Banner, Button, DateInput, Field, Header, Segmented, Spinner } from './ui';
import { TransfersView } from './archive';

const shortDate = (date: string) => dayMonth(date, true);

/** Все корректировки свободных средств таблицей. Нажатие на строку открывает правку. */
export function AdjustmentsScreen({ base, onBack }: { base: string; onBack: () => void }) {
  const { data, error, reload } = useLoad<Adjustment[]>(`${base}/adjustments`);
  const [editing, setEditing] = useState<Adjustment | 'new' | null>(null);
  const [tab, setTab] = useState<'adjustments' | 'transfers'>('adjustments');
  useBack(editing === null, 1, onBack);

  if (editing !== null) {
    return <AdjustmentForm base={base} adjustment={editing === 'new' ? undefined : editing} onClose={async () => { setEditing(null); await reload(); }} />;
  }

  const total = data?.reduce((sum, a) => sum + a.amount, 0) ?? 0;
  return (
    <>
      <Header title="Корректировки и переносы" onBack={onBack} />
      <Segmented value={tab} options={[['adjustments', 'Корректировки'], ['transfers', 'Переносы']]} onChange={setTab} />
      {tab === 'transfers' ? <TransfersView base={base} /> : <>
      <p className="muted small">Корректировка меняет свободные средства без дохода и расхода: пересчёт денег, кешбек, найденная разница.</p>
      <Button primary onClick={() => setEditing('new')}>Добавить корректировку</Button>
      {error && <Banner kind="error">{error}</Banner>}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <p className="muted">Корректировок нет.</p>}
      {!!data?.length && (
        <div className="table-wrap">
          <table className="compact-table adjustments-table">
            <thead>
              <tr><th>Дата</th><th>Причина и теги</th><th>{symbol()}</th></tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => setEditing(a)}>
                  <th scope="row">{shortDate(a.date)}{a.closed && <div className="muted small">закрыт</div>}</th>
                  <td className="wrap-cell">
                    {a.comment}
                    {a.tags.length > 0 && <div className="entry-tags small">{a.tags.map((t) => `#${t}`).join(' ')}</div>}
                  </td>
                  <td className={tone(a.amount)}>{signedCell(a.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th scope="row">Итого</th><td>{data.length} шт.</td><td className={tone(total)}><b>{signedCell(total)}</b></td></tr>
            </tfoot>
          </table>
        </div>
      )}
      </>}
    </>
  );
}

function AdjustmentForm({ base, adjustment, onClose }: { base: string; adjustment?: Adjustment; onClose: () => void }) {
  const { data: allTags } = useLoad<Tag[]>(`${base}/tags`);
  const [date, setDate] = useState(adjustment?.date ?? today());
  const [amount, setAmount] = useState(adjustment ? toInput(adjustment.amount) : '');
  const [comment, setComment] = useState(adjustment?.comment ?? '');
  const [tags, setTags] = useState<string[]>(adjustment?.tags ?? []);
  const [error, setError] = useState<string | null>(null);
  // В закрытом месяце дата и сумма открываются кнопкой; причину и теги можно менять сразу
  const [unlocked, setUnlocked] = useState(!adjustment?.closed);
  const closed = !unlocked;

  const snapshot = JSON.stringify([date, amount, comment, tags]);
  const baseline = useRef(snapshot);
  useUnsaved(snapshot !== baseline.current);
  useBack(true, 2, () => leaveForm(onClose));

  async function save() {
    const value = parseMoney(amount);
    if (!value) return setError('Введи сумму, можно с минусом.');
    const body = { date, amount: value, comment, tags };
    try {
      const done = await withRecalc((recalc) => (adjustment ? api.put(`${base}/adjustments/${adjustment.id}`, { ...body, recalc }) : api.post(`${base}/adjustments`, { ...body, recalc })));
      if (done !== null) onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    if (!adjustment || !(await confirmAction('Удалить корректировку?'))) return;
    try {
      if ((await withRecalc((recalc) => api.del(`${base}/adjustments/${adjustment.id}${recalc ? '?recalc=1' : ''}`))) !== null) onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const value = parseMoney(amount);
  return (
    <>
      <Header title={adjustment ? 'Корректировка' : 'Новая корректировка'} onBack={() => leaveForm(onClose)} />
      {error && <Banner kind="error">{error}</Banner>}
      {closed && (
        <Banner>
          Месяц закрыт. Причину и теги можно менять сразу. Если поменять дату или сумму, итоги этого и следующих месяцев пересчитаются.
          <div className="stack"><Button small onClick={() => setUnlocked(true)}>Редактировать дату и сумму</Button></div>
        </Banner>
      )}
      <Field label={`Сумма, ${symbol()}`} hint={value ? `Свободные средства: ${signed(value)}` : 'С минусом, если денег меньше, чем по расчёту'}>
        <input className="amount" inputMode="text" autoFocus={!adjustment} disabled={closed} value={amount} onChange={(e) => setAmount(numberInput(e.target.value, { minus: true }))} placeholder="0" />
      </Field>
      <Field label="Дата"><DateInput disabled={closed} value={date} onChange={setDate} /></Field>
      <Field label="Причина"><input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} /></Field>
      <div className="field">
        <span>Теги</span>
        <TagPicker value={tags} options={(allTags ?? []).map((t) => t.name)} onChange={setTags} />
      </div>
      <div className="stack">
        <Button primary onClick={save}>Сохранить</Button>
        {adjustment && <Button danger onClick={remove}>Удалить</Button>}
      </div>
    </>
  );
}
