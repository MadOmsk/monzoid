import { useState } from 'react';
import { api, confirmAction, useLoad, type Fund } from './api';
import { useUnsaved } from './back';
import { numberInput, dayMonth, fundLabel, money, parseMoney, toInput } from './format';
import { Banner, Button, DateInput, Field, Header, Segmented } from './ui';

export interface Reminder {
  id: number;
  comment: string;
  amount: number | null;
  fundId: number | null;
  fundName: string | null;
  dueDate: string;
  remindAt: number;
  status: 'scheduled' | 'due';
  repeat: 'week' | 'month' | null;
  /** Время оплаты ЧЧ:ММ */
  dueTime: string | null;
  anchorDay: number | null;
}


/** Напоминание уже сработало: платёж ждёт подтверждения. Не зависит от того, дошло ли сообщение. */
export const isDue = (r: Reminder) => r.status === 'due' || r.remindAt <= Date.now();

const pad = (n: number) => String(n).padStart(2, '0');
/** Локальное время для поля datetime-local */
function localInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function whenText(ms: number): string {
  const d = new Date(ms);
  return `${dayMonth(ymd(d))} в ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WEEKDAY_ACC = ['каждое воскресенье', 'каждый понедельник', 'каждый вторник', 'каждую среду', 'каждый четверг', 'каждую пятницу', 'каждую субботу'];
const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dayOf = (date: string) => new Date(`${date}T12:00`);

/** «Оплатить пт 5 дек в 10:00» */
function dueText(r: Reminder): string {
  return `Оплатить ${WEEKDAY_SHORT[dayOf(r.dueDate).getDay()]} ${dayMonth(r.dueDate)}${r.dueTime ? ` в ${r.dueTime}` : ''}`;
}
/** Расписание повтора: «каждый вторник», «каждое 5-е число» */
function scheduleText(r: Reminder): string {
  if (r.repeat === 'week') return WEEKDAY_ACC[dayOf(r.dueDate).getDay()];
  const day = r.anchorDay ?? Number(r.dueDate.slice(8, 10));
  return day === 31 ? 'каждый последний день месяца' : `каждое ${day}-е число`;
}
/** Сколько осталось до оплаты */
function untilText(date: string): string {
  const today = new Date();
  const days = Math.round((dayOf(date).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12).getTime()) / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'завтра';
  const d = days % 10, h = days % 100;
  return `через ${days} ${d === 1 && h !== 11 ? 'день' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'дня' : 'дней'}`;
}

/** Блок вверху «Операций»: сработавшие платежи с действиями и ближайшие запланированные. Новый платёж: кнопка ⏰ рядом с плюсом. */
export function RemindersBlock({ base, onEdit, onConfirm }: { base: string; onEdit: (r: Reminder) => void; onConfirm: (r: Reminder) => void }) {
  const { data, reload } = useLoad<Reminder[]>(`${base}/reminders`);
  const [error, setError] = useState<string | null>(null);
  const due = data?.filter(isDue) ?? [];
  const later = (data?.filter((r) => !isDue(r)) ?? []).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.dueTime ?? '').localeCompare(b.dueTime ?? ''));

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(r: Reminder) {
    const question = r.repeat ? `Удалить повторяющийся платёж «${r.comment}» совсем? Следующих напоминаний не будет.` : `Удалить платёж «${r.comment}»?`;
    if (await confirmAction(question)) await act(() => api.del(`${base}/reminders/${r.id}`));
  }
  const skip = (r: Reminder) => act(() => api.post(`${base}/reminders/${r.id}/skip`, {}));

  return (
    <div className="reminders">
      {error && <Banner kind="error">{error}</Banner>}
      {due.map((r) => (
        <div key={r.id} className="reminder due">
          <div className="entry-main">
            <span className="entry-title">{r.comment}</span>
            <b>{r.amount ? money(r.amount) : '—'}</b>
          </div>
          <div className="muted small">{[`Не подтверждено · ${dueText(r).toLowerCase()}`, r.repeat && scheduleText(r), r.fundName && fundLabel(r.fundName)].filter(Boolean).join(' · ')}</div>
          <div className="reminder-actions">
            <Button small primary onClick={() => onConfirm(r)}>Подтвердить</Button>
            <Button small onClick={() => onEdit(r)}>Перенести</Button>
            {r.repeat && <Button small onClick={() => skip(r)}>Пропустить раз</Button>}
            <Button small danger onClick={() => remove(r)}>{r.repeat ? 'Удалить совсем' : 'Удалить'}</Button>
          </div>
        </div>
      ))}
      {later.length > 0 && (
        <details className="reminder-later">
          <summary>Запланировано: {later.length}</summary>
          <ul className="entry-list reminder-list">
            {later.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onEdit(r)}>
                  <div className="entry-main">
                    <span className="entry-title">{r.comment}</span>
                    <b>{r.amount ? money(r.amount) : <span className="muted">сумма при оплате</span>}</b>
                  </div>
                  <div className="entry-main small">
                    <span>{dueText(r)}</span>
                    <span className="muted entry-date">{untilText(r.dueDate)}</span>
                  </div>
                  <div className="muted small">
                    {[r.repeat && scheduleText(r), r.fundName && fundLabel(r.fundName), `напомню ${whenText(r.remindAt)}`].filter(Boolean).join(' · ')}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

type Period = 'once' | 'week' | 'month';
const WEEKDAYS: [number, string][] = [[1, 'Понедельник'], [2, 'Вторник'], [3, 'Среда'], [4, 'Четверг'], [5, 'Пятница'], [6, 'Суббота'], [0, 'Воскресенье']];
/** «Напомнить за»: минуты до оплаты */
const BEFORE: [number, string][] = [[0, 'В момент оплаты'], [15, 'За 15 минут'], [60, 'За 1 час'], [180, 'За 3 часа'], [1440, 'За 1 день'], [2880, 'За 2 дня'], [10080, 'За неделю']];
const UNITS: [number, string][] = [[1, 'минут'], [60, 'часов'], [1440, 'дней']];

const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Момент оплаты по часам устройства */
const dueMoment = (date: string, time: string) => new Date(`${date}T${time}`).getTime();

/** Ближайшая оплата по расписанию, напоминание о которой ещё впереди. */
function nextDue(period: Period, weekday: number, monthDay: number, time: string, beforeMin: number): string {
  const now = Date.now();
  const start = new Date();
  for (let i = 0; i < 400; i++) {
    const d = period === 'week'
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      : new Date(start.getFullYear(), start.getMonth() + i, Math.min(monthDay, new Date(start.getFullYear(), start.getMonth() + i + 1, 0).getDate()));
    if (period === 'week' && d.getDay() !== weekday) continue;
    if (dueMoment(ymd(d), time) - beforeMin * 60_000 > now) return ymd(d);
  }
  return ymd(start);
}

/** Новый платёж или перенос существующего: сначала периодичность, потом день и время, напоминание «за …». */
export function ReminderForm({ base, reminder, onClose }: { base: string; reminder?: Reminder; onClose: () => void }) {
  const { data: funds } = useLoad<Fund[]>(`${base}/funds`);
  const tomorrow = ymd(new Date(Date.now() + 86_400_000));
  const startDate = reminder?.dueDate ?? tomorrow;
  const startTime = reminder?.dueTime ?? '10:00';
  // Прежнее напоминание переводится в «за …», если совпадает с вариантом; иначе своё или точное время
  const oldBefore = reminder ? Math.round((dueMoment(startDate, startTime) - reminder.remindAt) / 60_000) : 60;
  const preset = BEFORE.some(([m]) => m === oldBefore);
  const [comment, setComment] = useState(reminder?.comment ?? '');
  const [amount, setAmount] = useState(reminder?.amount ? toInput(reminder.amount) : '');
  const [fund, setFund] = useState<number | ''>(reminder?.fundId ?? '');
  const [period, setPeriod] = useState<Period>(reminder?.repeat ?? 'once');
  const [date, setDate] = useState(startDate);
  const [weekday, setWeekday] = useState(new Date(`${startDate}T12:00`).getDay());
  const [monthDay, setMonthDay] = useState(reminder?.anchorDay ?? Number(startDate.slice(8, 10)));
  const [time, setTime] = useState(startTime);
  const [mode, setMode] = useState<'preset' | 'custom' | 'exact'>(preset || oldBefore < 0 ? (oldBefore < 0 ? 'exact' : 'preset') : 'custom');
  const [before, setBefore] = useState(preset ? oldBefore : 60);
  const unitOf = (m: number) => (m % 1440 === 0 ? 1440 : m % 60 === 0 ? 60 : 1);
  const [customN, setCustomN] = useState(String(preset || oldBefore < 0 ? 2 : oldBefore / unitOf(oldBefore)));
  const [customUnit, setCustomUnit] = useState(preset || oldBefore < 0 ? 60 : unitOf(oldBefore));
  const [exact, setExact] = useState(reminder ? localInput(reminder.remindAt) : `${tomorrow}T09:00`);
  const [error, setError] = useState<string | null>(null);
  useUnsaved(!reminder && (!!comment || !!amount));

  const beforeMin = mode === 'custom' ? Math.max(0, Math.round(Number(customN) || 0)) * customUnit : mode === 'preset' ? before : 0;
  // Если в расписании ничего не меняли, остаётся текущий раз (в том числе уже наступивший)
  const sameSchedule = !!reminder && period === (reminder.repeat ?? 'once') && time === startTime && mode !== 'exact' && beforeMin === oldBefore
    && (period === 'once' ? date === startDate : period === 'week' ? weekday === new Date(`${startDate}T12:00`).getDay() : monthDay === (reminder.anchorDay ?? Number(startDate.slice(8, 10))));
  const dueDate = period === 'once' ? date : sameSchedule ? startDate : nextDue(period, weekday, monthDay, time, beforeMin);
  const remindAt = mode === 'exact' && period === 'once' ? new Date(exact).getTime() : dueMoment(dueDate, time) - beforeMin * 60_000;

  async function save() {
    const value = amount.trim() ? parseMoney(amount) : null;
    if (value !== null && !(value > 0)) return setError('Сумма должна быть больше нуля или пустой.');
    if (!date || !time || !remindAt) return setError('Укажи дату и время.');
    const body = { comment, amount: value, fundId: fund === '' ? null : fund, dueDate, dueTime: time, remindAt, repeat: period === 'once' ? null : period, ...(period === 'month' ? { anchorDay: monthDay } : {}) };
    try {
      if (reminder) await api.put(`${base}/reminders/${reminder.id}`, body);
      else await api.post(`${base}/reminders`, body);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="screen">
      <Header title={reminder ? 'Платёж' : 'Запланировать платёж'} onBack={onClose} />
      {error && <Banner kind="error">{error}</Banner>}
      <Field label="За что">
        <input value={comment} maxLength={300} placeholder="Садик" onChange={(e) => setComment(e.target.value)} />
      </Field>
      <Field label="Сумма" hint="Можно оставить пустой и указать при подтверждении.">
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(numberInput(e.target.value))} />
      </Field>
      <Field label="Фонд">
        <select value={fund} onChange={(e) => setFund(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Выберу при подтверждении</option>
          {funds?.filter((f) => !f.archived).map((f) => <option key={f.id} value={f.id}>{fundLabel(f.name)}</option>)}
        </select>
      </Field>

      <h2>Когда оплатить</h2>
      <Segmented<Period> value={period} options={[['once', 'Один раз'], ['week', 'Каждую неделю'], ['month', 'Каждый месяц']]} onChange={(p) => { setPeriod(p); if (p !== 'once' && mode === 'exact') setMode('preset'); }} />
      <div className="range-row">
        {period === 'once' && (
          <Field label="Дата"><DateInput value={date} min={reminder ? undefined : ymd(new Date())} onChange={setDate} /></Field>
        )}
        {period === 'week' && (
          <Field label="День недели">
            <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
              {WEEKDAYS.map(([d, name]) => <option key={d} value={d}>{name}</option>)}
            </select>
          </Field>
        )}
        {period === 'month' && (
          <Field label="Число">
            <select value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d === 31 ? '31 (или последний день)' : d}</option>)}
            </select>
          </Field>
        )}
        <Field label="Время"><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
      </div>

      <h2>Напомнить</h2>
      <select aria-label="Напомнить" value={mode === 'preset' ? String(before) : mode} onChange={(e) => {
        const v = e.target.value;
        if (v === 'custom' || v === 'exact') setMode(v);
        else { setMode('preset'); setBefore(Number(v)); }
      }}>
        {BEFORE.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
        <option value="custom">Своё: за …</option>
        {period === 'once' && <option value="exact">В конкретную дату и время</option>}
      </select>
      {mode === 'custom' && (
        <div className="inline-form">
          <span>За</span>
          <input aria-label="Сколько" inputMode="numeric" value={customN} onChange={(e) => setCustomN(e.target.value.replace(/\D/g, ''))} />
          <select aria-label="Единица" value={customUnit} onChange={(e) => setCustomUnit(Number(e.target.value))}>
            {UNITS.map(([u, label]) => <option key={u} value={u}>{label}</option>)}
          </select>
        </div>
      )}
      {mode === 'exact' && period === 'once' && <DateInput withTime label="Когда напомнить" value={exact} onChange={setExact} />}

      <p className="muted small">
        {remindAt ? <>Ближайшая оплата {dayMonth(dueDate)} в {time}, напомню {whenText(remindAt)}.</> : 'Укажи дату и время.'}
        {period !== 'once' && ' Следующий платёж появится сам после подтверждения или пропуска.'}
        {remindAt && remindAt <= Date.now() && ' Напоминание уже в прошлом: платёж сразу появится в «Операциях».'}
      </p>
      <Button primary onClick={save}>{reminder ? 'Сохранить' : 'Запланировать'}</Button>
    </div>
  );
}
