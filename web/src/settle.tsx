import { useState } from 'react';
import { api, confirmAction, useLoad, type Summary } from './api';
import { numberInput, dayMonth, memberLabel, money, parseMoney, toInput, today } from './format';
import { Banner, Button, DateInput, Field, Header } from './ui';

type Settlement = { id: number; userId: number; name: string; date: string; amount: number; comment: string };

/** Расчёты с участниками: долг, дата последнего расчёта и выплата. Открывается кнопкой рядом с плюсом. */
export function SettleScreen({ base, ym, isAdmin, onClose }: { base: string; ym: string; isAdmin: boolean; onClose: () => void }) {
  const { data, reload } = useLoad<Summary>(`${base}/summary?ym=${ym}`);
  const { data: list, reload: reloadList } = useLoad<Settlement[]>(`${base}/settlements`);
  const debts = data?.debts ?? [];
  // Чаще всего рассчитываются с одним человеком, поэтому он выбран сразу
  const [user, setUser] = useState<number | ''>('');
  const chosen = user === '' ? (debts.length === 1 ? debts[0].userId : '') : user;
  const [amount, setAmount] = useState<string | null>(null);
  const [date, setDate] = useState(today());
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const debt = debts.find((d) => d.userId === chosen);
  // Пока сумму не трогали, подставляется весь долг
  const shownAmount = amount ?? (debt && debt.owed > 0 ? toInput(debt.owed) : '');

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      setError(null);
      setAmount(null);
      setComment('');
      await Promise.all([reload(), reloadList()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function pay() {
    const value = parseMoney(shownAmount);
    if (chosen === '' || !value || value <= 0) return setError('Выбери участника и сумму.');
    await act(() => api.post(`${base}/settlements`, { userId: chosen, date, amount: value, comment, settledUntil: date }));
  }

  async function markOnly() {
    if (chosen === '') return setError('Выбери участника.');
    await act(() => api.patch(`${base}/members/${chosen}`, { settledUntil: date }));
  }

  return (
    <div className="screen">
      <Header title="Расчёты" onBack={onClose} />
      {error && <Banner kind="error">{error}</Banner>}
      <ul className="simple-list">
        {debts.filter((d) => d.owed !== 0 || d.credited).map((d) => (
          <li key={d.userId} className="settle-row">
            <span>
              {memberLabel(d.name)}
              <small className="muted">{d.settledUntil ? `расчёт по ${dayMonth(d.settledUntil)}` : 'дата расчёта не отмечена'}</small>
            </span>
            {d.owed > 0 && <span>база должна <b>{money(d.owed)}</b></span>}
            {d.owed < 0 && <span>переплата <b>{money(-d.owed)}</b></span>}
            {d.owed === 0 && <span className="muted">расчёт закрыт</span>}
          </li>
        ))}
      </ul>
      {isAdmin && (
        <>
          <h2>Рассчитаться</h2>
          {debts.length > 1 && (
            <Field label="С кем">
              <select value={chosen} onChange={(e) => { setUser(e.target.value ? Number(e.target.value) : ''); setAmount(null); }}>
                <option value="">Выбери участника</option>
                {debts.map((d) => <option key={d.userId} value={d.userId}>{memberLabel(d.name)}</option>)}
              </select>
            </Field>
          )}
          <Field label="Выплата" hint="Подставлен весь долг. Выплата уменьшает долг и не считается расходом.">
            <input inputMode="decimal" placeholder="Сумма" value={shownAmount} onChange={(e) => setAmount(numberInput(e.target.value))} />
          </Field>
          <Field label="Дата расчёта" hint="Запомнится как дата последнего расчёта.">
            <DateInput value={date} max={today()} onChange={setDate} />
          </Field>
          <Field label="Комментарий">
            <input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} />
          </Field>
          <Button primary onClick={pay}>Выплатить</Button>
          <Button onClick={markOnly}>Только отметить дату расчёта</Button>
        </>
      )}
      {!!list?.length && <h2>Последние выплаты</h2>}
      <ul className="simple-list">
        {list?.slice(0, 10).map((s) => (
          <li key={s.id}>
            <span>{dayMonth(s.date)} · {memberLabel(s.name)}{s.comment && <small className="muted"> · {s.comment}</small>}</span>
            <span style={{ whiteSpace: 'nowrap' }}>
              {money(s.amount)}{' '}
              {isAdmin && <button className="icon" aria-label="Удалить выплату" onClick={async () => { if (await confirmAction('Удалить выплату?')) await act(() => api.del(`${base}/settlements/${s.id}`)); }}>×</button>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
