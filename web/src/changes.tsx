import { useState } from 'react';
import { api, confirmAction, useLoad, type ClosedChange, type ChangeState } from './api';
import { useBack } from './back';
import { dayMonth, money, signed } from './format';
import { Banner, Button, Header, Spinner } from './ui';

const ACTIONS: Record<ClosedChange['action'], string> = { create: 'Добавлена', update: 'Изменена', delete: 'Удалена' };
const KINDS: Record<ClosedChange['kind'], string> = { entry: 'операция', adjustment: 'корректировка', asset_value: 'оценка актива', pot_move: 'сделка по вкладу', transfer: 'перенос остатка' };

function when(sqlTime: string): string {
  return new Date(`${sqlTime.replace(' ', 'T')}Z`).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function sum(state: ChangeState, kind: ClosedChange['kind']): string {
  return kind === 'adjustment' ? signed(state.amount) : money(state.amount);
}

/** Что поменялось: только отличающиеся поля. */
function differences(c: ClosedChange): string[] {
  const { before, after } = c;
  if (!before || !after) return [];
  const lines: string[] = [];
  if (before.amount !== after.amount) lines.push(`Сумма: ${sum(before, c.kind)} → ${sum(after, c.kind)}`);
  if (before.date !== after.date) lines.push(`Дата: ${dayMonth(before.date, true)} → ${dayMonth(after.date, true)}`);
  if (c.fundBefore !== c.fundAfter) lines.push(`Фонд: ${c.fundBefore ?? '—'} → ${c.fundAfter ?? '—'}`);
  if (before.comment !== after.comment) lines.push(`Комментарий: ${before.comment || '—'} → ${after.comment || '—'}`);
  if (before.tags.join() !== after.tags.join()) lines.push(`Теги: ${before.tags.map((t) => `#${t}`).join(' ') || '—'} → ${after.tags.map((t) => `#${t}`).join(' ') || '—'}`);
  return lines;
}

/** История изменений: последние добавления, правки и удаления. Отмена возвращает запись к состоянию до изменения. */
export function ChangesScreen({ base, onBack }: { base: string; onBack: () => void }) {
  const { data, error, reload } = useLoad<ClosedChange[]>(`${base}/changes`);
  const [actionError, setActionError] = useState<string | null>(null);
  useBack(true, 1, onBack);

  async function revert(c: ClosedChange) {
    if (!(await confirmAction('Отменить это изменение? Если оно в закрытом месяце, итоги пересчитаются.'))) return;
    try {
      await api.post(`${base}/changes/${c.id}/revert`, { recalc: true });
      setActionError(null);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <>
      <Header title="История изменений" onBack={onBack} />
      <p className="muted small">Последние добавления, правки и удаления операций, сделок по вкладам, оценок, корректировок и переносов. Отмена возвращает запись как было. Если запись меняли несколько раз, отменяй с самого нового изменения.</p>
      {(error || actionError) && <Banner kind="error">{error ?? actionError}</Banner>}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <p className="muted">Изменений пока не было.</p>}
      <ul className="entry-list">
        {data?.map((c) => {
          const state = c.after ?? c.before!;
          const fund = c.kind === 'entry' ? (state.kind === 'income' ? 'Доход' : c.fundAfter ?? c.fundBefore) : c.kind === 'adjustment' ? 'Корректировка' : c.fundAfter ?? c.fundBefore;
          return (
            <li key={c.id}>
              <div className={`static${c.revertedAt ? ' reverted' : ''}`}>
                <div className="entry-main">
                  <span className="entry-title">{ACTIONS[c.action]} {KINDS[c.kind]}</span>
                  <span className="muted small entry-date">{when(c.createdAt)}</span>
                </div>
                <div className="entry-main small">
                  <span className="entry-note">{fund} · {state.comment || 'без комментария'}</span>
                  <b>{sum(state, c.kind)}</b>
                </div>
                <div className="muted small">{dayMonth(state.date, true)}{c.userName && ` · ${c.userName}`}</div>
                {differences(c).map((line) => <div key={line} className="small">{line}</div>)}
                {c.revertedAt ? (
                  <div className="muted small">Отменено {when(c.revertedAt)}</div>
                ) : (
                  <div className="stack"><Button small onClick={() => revert(c)}>Отменить</Button></div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
