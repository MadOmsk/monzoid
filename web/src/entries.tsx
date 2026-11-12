import { useEffect, useRef, useState } from 'react';
import { RemindersBlock, type Reminder } from './reminders';
import { api, confirmAction, useLoad, withRecalc, type Entry, type Fund, type Member, type Pot, type Refundable, type Tag } from './api';
import { leaveForm, useBack, useUnsaved } from './back';
import { numberInput, dayMonth, defaultDate, fundLabel, memberLabel, money, parseMoney, monthShort, shiftYm, signed, symbol } from './format';
import { TagPicker } from './tags';
import { Banner, Button, DateInput, Field, FundTiles, Header, MonthNav, Segmented, Spinner } from './ui';

/** Период списка операций: месяц из навигации, выбранный диапазон месяцев или всё время. */
export interface EntryPeriod {
  mode: 'month' | 'range' | 'all';
  from: string;
  to: string;
}

const ALL_TO = '9999-12';

/** Какие операции показывать. Возврат это расход с минусом, он среди расходов. */
export type EntryKind = 'all' | 'expense' | 'income';

/**
 * Поиск, тег, раскрытые фильтры и место прокрутки списка. Экран размонтируется, пока открыта операция,
 * поэтому они хранятся вне компонента, отдельно для каждой базы, и живут, пока открыто приложение.
 * Период, вид и фонд хранит App: они общие с экраном «Месяц».
 */
interface EntriesView {
  query: string;
  tagId: number | null;
  /** Источник дохода (категория из статистики «Доходы») */
  source: string | null;
  /** Кто платил за расход: 'base' из общих денег, иначе ID участника */
  paidBy: 'base' | number | null;
  filtersOpen: boolean;
  /** Период стал «Всё время» сам, когда начали искать */
  autoAll: boolean;
  /** Прокрутка перед открытием операции; восстанавливается один раз после загрузки списка */
  scrollY: number | null;
}
const views = new Map<string, EntriesView>();
function viewOf(base: string): EntriesView {
  if (!views.has(base)) views.set(base, { query: '', tagId: null, source: null, paidBy: null, filtersOpen: false, autoAll: false, scrollY: null });
  return views.get(base)!;
}

const LONG_PRESS_MS = 450;
const PRESS_DRIFT_PX = 10;

export function EntriesScreen({ base, ym, onYm, period, onPeriod, kind, onKind, startYm, currentYm, userId, isAdmin, locked, fundId, onFund, onEdit, onReminder, onConfirm, onSelecting }: {
  base: string;
  ym: string;
  onYm: (ym: string) => void;
  period: EntryPeriod;
  onPeriod: (period: EntryPeriod) => void;
  kind: EntryKind;
  onKind: (kind: EntryKind) => void;
  startYm: string;
  currentYm: string;
  userId: number;
  isAdmin: boolean;
  locked: boolean;
  fundId: number | null;
  onFund: (id: number | null) => void;
  onEdit: (entry: Entry) => void;
  onReminder: (reminder: Reminder) => void;
  onConfirm: (reminder: Reminder) => void;
  /** Режим отметки: App прячет круглые кнопки, чтобы они не закрывали панель */
  onSelecting: (selecting: boolean) => void;
}) {
  const view = viewOf(base);
  const [tagId, setTagIdState] = useState<number | null>(view.tagId);
  const setTagId = (id: number | null) => {
    view.tagId = id;
    setTagIdState(id);
  };
  const [source, setSourceState] = useState<string | null>(view.source);
  const setSource = (value: string | null) => {
    view.source = value;
    setSourceState(value);
  };
  const [paidBy, setPaidByState] = useState<'base' | number | null>(view.paidBy);
  const setPaidBy = (value: 'base' | number | null) => {
    view.paidBy = value;
    setPaidByState(value);
  };
  const [query, setQueryState] = useState(view.query);
  const setQuery = (text: string) => {
    view.query = text;
    setQueryState(text);
  };
  const [search, setSearch] = useState(view.query.trim());
  // Запрос уходит на сервер, когда человек перестал печатать
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  // Поиск идёт за выбранный период. Когда поиск только начат из режима «Месяц», период сам становится «Всё время»,
  // иначе нужное легко не найти; потом его можно сузить
  // Если период не трогали во время поиска, после очистки поиска возвращается «Месяц»
  const searching = useRef(!!search);
  useEffect(() => {
    if (search && !searching.current && period.mode === 'month') {
      view.autoAll = true;
      onPeriod({ ...period, mode: 'all' });
    }
    if (!search && searching.current && view.autoAll && period.mode === 'all') onPeriod({ ...period, mode: 'month' });
    if (!search) view.autoAll = false;
    searching.current = !!search;
  }, [search]);
  const choosePeriod = (mode: EntryPeriod['mode']) => {
    view.autoAll = false;
    setMode(mode);
  };
  const [from, to] = period.mode === 'all' ? [startYm, ALL_TO] : period.mode === 'month' ? [ym, ym] : [period.from, period.to];
  // У доходов нет фонда, поэтому фильтр по фонду для них не применяется
  const byFund = kind !== 'income' && fundId;
  // Источник только у доходов, плательщик только у расходов
  const bySource = kind === 'income' && source;
  const byPayer = kind === 'expense' && paidBy !== null;
  const { data, error, reload } = useLoad<Entry[]>(`${base}/entries?from=${from}&to=${to}${kind !== 'all' ? `&kind=${kind}` : ''}${byFund ? `&fundId=${fundId}` : ''}${bySource ? `&source=${encodeURIComponent(source)}` : ''}${byPayer ? `&paidBy=${paidBy}` : ''}${tagId ? `&tagId=${tagId}` : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`);
  // Возврат из операции: список встаёт туда, где был
  useEffect(() => {
    if (!data || view.scrollY === null) return;
    const y = view.scrollY;
    view.scrollY = null;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }, [data]);
  const several = period.mode !== 'month' || !!search;
  const spent = data?.reduce((s, e) => s + (e.kind === 'expense' ? e.amount : 0), 0) ?? 0;
  const earned = data?.reduce((s, e) => s + (e.kind === 'income' ? e.amount : 0), 0) ?? 0;
  const setMode = (mode: EntryPeriod['mode']) => onPeriod(mode === 'range' && period.mode !== 'range' ? { mode, from: shiftYm(ym, -2) < startYm ? startYm : shiftYm(ym, -2), to: ym } : { ...period, mode });
  const setRange = (key: 'from' | 'to', raw: string) => {
    if (!raw) return;
    // Поле месяца в некоторых браузерах пропускает значения вне min и max
    const value = raw < startYm ? startYm : raw > currentYm ? currentYm : raw;
    const next = { ...period, [key]: value };
    // Границы не перекрещиваются: двигается вторая
    if (next.from > next.to) next[key === 'from' ? 'to' : 'from'] = value;
    onPeriod(next);
  };
  const { data: funds } = useLoad<Fund[]>(`${base}/funds`);
  const { data: tags } = useLoad<Tag[]>(`${base}/tags`);
  const { data: incomeTotals } = useLoad<{ category: string; total: number }[]>(kind === 'income' ? `${base}/incomes/categories` : null);
  const { data: members } = useLoad<Member[]>(kind === 'expense' ? `${base}/members` : null);
  // Источники по сумме за всё время, крупные сверху
  const sourceList = [...(incomeTotals ?? []).reduce((m, r) => m.set(r.category, (m.get(r.category) ?? 0) + r.total), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  const payerName = typeof paidBy === 'number' ? members?.find((m) => m.userId === paidBy)?.name : null;
  // Фильтры спрятаны под кнопку; выбранные видны плашками под поиском, каждую можно снять
  const [filtersOpen, setFiltersOpenState] = useState(view.filtersOpen);
  const setFiltersOpen = (open: boolean) => {
    view.filtersOpen = open;
    setFiltersOpenState(open);
  };
  const fundName = funds?.find((f) => f.id === fundId)?.name;
  const tagName = tags?.find((t) => t.id === tagId)?.name;
  const chips: { key: string; label: string; clear: () => void }[] = [
    ...(search ? [{ key: 'q', label: `«${search}»`, clear: () => { setQuery(''); setSearch(''); } }] : []),
    ...(period.mode === 'all' ? [{ key: 'p', label: 'Всё время', clear: () => choosePeriod('month') }] : []),
    ...(period.mode === 'range' ? [{ key: 'p', label: period.from === period.to ? monthShort(period.from) : `${monthShort(period.from)} – ${monthShort(period.to)}`, clear: () => choosePeriod('month') }] : []),
    ...(kind !== 'all' ? [{ key: 'k', label: kind === 'income' ? 'Доходы' : 'Расходы', clear: () => onKind('all') }] : []),
    ...(byFund && fundName ? [{ key: 'f', label: fundLabel(fundName), clear: () => onFund(null) }] : []),
    ...(tagName ? [{ key: 't', label: `#${tagName}`, clear: () => setTagId(null) }] : []),
    ...(bySource ? [{ key: 's', label: source, clear: () => setSource(null) }] : []),
    ...(byPayer ? [{ key: 'w', label: paidBy === 'base' ? 'Из общих' : `Платил(а): ${memberLabel(payerName ?? '')}`, clear: () => setPaidBy(null) }] : []),
  ];
  // Поиск виден в самом поле, на кнопке считаются остальные фильтры
  const activeCount = chips.filter((c) => c.key !== 'q').length;

  // Отметка долгим нажатием: дальше короткое нажатие отмечает или снимает операцию
  const canEdit = (e: Entry) => !e.autoCredit && (isAdmin || e.createdBy === userId);
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const selecting = selected !== null && !locked;
  useEffect(() => {
    onSelecting(selecting);
    return () => onSelecting(false);
  }, [selecting]);
  useBack(selecting && !bulkOpen, 1, () => setSelected(null));
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const toggle = (id: number) => setSelected((s) => {
    const next = new Set(s ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const startSelect = (id: number) => setSelected((s) => new Set([...(s ?? []), id]));
  const pressHandlers = (e: Entry) => locked || !canEdit(e) ? {} : {
    onPointerDown: (ev: React.PointerEvent) => {
      if (ev.button !== 0) return;
      const timer = window.setTimeout(() => {
        if (press.current) press.current.fired = true;
        startSelect(e.id);
        navigator.vibrate?.(15);
      }, LONG_PRESS_MS);
      press.current = { timer, x: ev.clientX, y: ev.clientY, fired: false };
    },
    onPointerMove: (ev: React.PointerEvent) => {
      const p = press.current;
      if (p && !p.fired && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > PRESS_DRIFT_PX) {
        clearTimeout(p.timer);
        press.current = null;
      }
    },
    onPointerUp: () => press.current && clearTimeout(press.current.timer),
    onPointerCancel: () => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
    },
    // Долгое нажатие в Android и правая кнопка мыши дают контекстное меню: вместо него отметка
    onContextMenu: (ev: React.MouseEvent) => {
      ev.preventDefault();
      if (press.current) {
        clearTimeout(press.current.timer);
        press.current.fired = true;
      }
      startSelect(e.id);
    },
  };
  const open = (e: Entry) => {
    // Нажатие, которое закончило долгое, ничего не открывает
    if (press.current?.fired) {
      press.current = null;
      return;
    }
    press.current = null;
    if (selecting) {
      if (canEdit(e)) toggle(e.id);
      return;
    }
    view.scrollY = window.scrollY;
    onEdit(e);
  };
  const editable = data?.filter(canEdit) ?? [];
  const allSelected = !!selected && editable.length > 0 && editable.every((e) => selected.has(e.id));

  if (bulkOpen && selected?.size) {
    return (
      <BulkEditor
        base={base}
        entries={(data ?? []).filter((e) => selected.has(e.id))}
        count={selected.size}
        ids={[...selected]}
        funds={(funds ?? []).filter((f) => !f.archived)}
        tags={tags ?? []}
        onClose={() => setBulkOpen(false)}
        onDone={() => {
          setBulkOpen(false);
          setSelected(null);
          void reload();
        }}
      />
    );
  }

  return (
    <>
      {!selecting && <RemindersBlock base={base} onEdit={onReminder} onConfirm={onConfirm} />}
      <div className="search-row">
        <input type="search" className="entry-search" aria-label="Поиск по операциям" placeholder="Поиск: магазин, комментарий, тег, сумма" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className={`btn small filter-toggle${filtersOpen ? ' active' : ''}`} aria-label={activeCount ? `Фильтр, выбрано: ${activeCount}` : 'Фильтр'} title="Фильтр" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
          {/* Воронка: цвет берётся из текста кнопки */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5z" />
          </svg>
          {activeCount > 0 && <span className="filter-count">{activeCount}</span>}
        </button>
      </div>
      {chips.length > 0 && (
        <div className="chips filter-chips">
          {chips.map((c) => (
            <span key={c.key} className="chip selected filter-chip">
              {c.label}
              <button type="button" aria-label={`Убрать фильтр: ${c.label}`} onClick={c.clear}>×</button>
            </span>
          ))}
        </div>
      )}
      {filtersOpen && (
        <div className="filter-panel">
          <Segmented value={period.mode} options={[['month', 'Месяц'], ['range', 'Период'], ['all', 'Всё время']]} onChange={choosePeriod} />
          {period.mode === 'range' && (
            <div className="range-row">
              <Field label="С"><input type="month" value={period.from} min={startYm} max={currentYm} onChange={(e) => setRange('from', e.target.value)} /></Field>
              <Field label="По"><input type="month" value={period.to} min={startYm} max={currentYm} onChange={(e) => setRange('to', e.target.value)} /></Field>
            </div>
          )}
          <Segmented value={kind} options={[['expense', 'Расходы'], ['income', 'Доходы'], ['all', 'Все']]} onChange={onKind} />
          {kind !== 'income' && <FundTiles collapsible funds={(funds ?? []).filter((f) => !f.archived || f.id === fundId)} value={fundId} allLabel="Все фонды" onChange={onFund} />}
          {kind === 'income' && sourceList.length > 0 && (
            <select aria-label="Источник дохода" value={source ?? ''} onChange={(e) => setSource(e.target.value || null)}>
              <option value="">Все источники</option>
              {sourceList.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          {kind === 'expense' && !!members?.length && (
            <select aria-label="Кто платил" value={paidBy ?? ''} onChange={(e) => setPaidBy(e.target.value === '' ? null : e.target.value === 'base' ? 'base' : Number(e.target.value))}>
              <option value="">Кто платил: все</option>
              <option value="base">Из общих денег</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{memberLabel(m.name)}</option>)}
            </select>
          )}
          {!!tags?.length && (
            <select aria-label="Фильтр по тегу" value={tagId ?? ''} onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Все теги</option>
              {tags.map((t) => <option key={t.id} value={t.id}>#{t.name}</option>)}
            </select>
          )}
          <Button small onClick={() => setFiltersOpen(false)}>Готово</Button>
        </div>
      )}
      {/* Месяц это навигация, а не фильтр: стрелки видны всегда */}
      {period.mode === 'month' && <MonthNav ym={ym} onYm={onYm} min={startYm} max={currentYm} />}
      {error && <Banner kind="error">{error}</Banner>}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <p className="muted">{search ? 'Ничего не нашлось.' : 'Операций нет.'}</p>}
      {(several || kind !== 'all') && !!data?.length && (
        <p className="muted small">
          {data.length} шт.{kind !== 'income' && <> · расходы {money(spent)}</>}{kind !== 'expense' && earned > 0 && <> · доходы {money(earned)}</>}
        </p>
      )}
      {!selecting && !locked && !!editable.length && <p className="muted small hint-select">Долгое нажатие на операцию: отметить несколько и править вместе.</p>}
      <ul className={`entry-list${selecting ? ' selecting' : ''}`}>
        {data?.map((e) => {
          const note = e.comment || e.description;
          const refund = e.refundOf ? `возврат за «${e.refundOf.note || 'покупку'}» от ${dayMonth(e.refundOf.date, true)}` : e.amount < 0 && 'возврат';
          const returned = e.refunded > 0 && (e.refunded >= e.amount ? 'возвращено полностью' : `возвращено ${money(e.refunded)} из ${money(e.amount)}`);
          const extra = [refund, returned, e.paidByName && `платил(а): ${memberLabel(e.paidByName)}`, memberLabel(e.earnedByName)].filter(Boolean).join(' · ');
          const checked = !!selected?.has(e.id);
          const body = (
            <>
              <div className="entry-main">
                {selecting && <span className={`entry-check${checked ? ' on' : ''}`} aria-hidden>{checked ? '✓' : ''}</span>}
                <span className="entry-title">{e.kind === 'income' ? 'Доход' : e.fundName ? fundLabel(e.fundName) : e.potName ? `Актив: ${e.potName}` : '—'}</span>
                <b className={`${e.kind === 'income' || e.amount < 0 ? 'positive' : ''}${e.refunded > 0 && e.refunded >= e.amount ? ' refunded' : ''}`}>{e.kind === 'income' || e.amount < 0 ? signed(Math.abs(e.amount)) : money(e.amount)}</b>
              </div>
              <div className="entry-main small">
                <span className="entry-note">{note}</span>
                <span className="muted entry-date">{dayMonth(e.date, several)}</span>
              </div>
              {e.comment && e.description && <div className="muted small">{e.description}</div>}
              {extra && <div className="muted small">{extra}</div>}
              {e.tags.length > 0 && <div className="entry-tags small">{e.tags.map((t) => `#${t}`).join(' ')}</div>}
            </>
          );
          return (
            <li key={e.id} className={selecting && !canEdit(e) ? 'unselectable' : checked ? 'checked' : ''}>
              {canEdit(e) ? <button aria-pressed={selecting ? checked : undefined} onClick={() => open(e)} {...pressHandlers(e)}>{body}</button> : <div className="static">{body}</div>}
            </li>
          );
        })}
      </ul>
      {selecting && (
        <div className="select-bar" role="toolbar" aria-label="Отмеченные операции">
          <button type="button" className="btn small" aria-label="Снять отметку" onClick={() => setSelected(null)}>✕</button>
          <span className="select-count">Отмечено: {selected.size}</span>
          <button type="button" className="btn small" onClick={() => setSelected(allSelected ? new Set() : new Set(editable.map((e) => e.id)))}>{allSelected ? 'Снять все' : 'Все'}</button>
          <button type="button" className="btn small primary" disabled={!selected.size} onClick={() => setBulkOpen(true)}>Редактировать</button>
        </div>
      )}
    </>
  );
}

/** Правка всех отмеченных операций: теги, фонд, комментарий, сумма или удаление. Пересчёт закрытых месяцев спрашивается один раз. */
function BulkEditor({ base, entries, count, ids, funds, tags, onClose, onDone }: {
  base: string;
  /** Отмеченные операции из текущего списка: по ним видно, какие теги можно убрать */
  entries: Entry[];
  count: number;
  ids: number[];
  funds: Fund[];
  tags: Tag[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [addTags, setAddTags] = useState<string[]>([]);
  const [removeTags, setRemoveTags] = useState<string[]>([]);
  const [fund, setFund] = useState<number | null>(null);
  const [changeComment, setChangeComment] = useState(false);
  const [comment, setComment] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dirty = addTags.length > 0 || removeTags.length > 0 || fund !== null || changeComment || amount !== '';
  useUnsaved(dirty);
  useBack(true, 2, () => leaveForm(onClose));
  const present = [...new Set(entries.flatMap((e) => e.tags))].sort();
  const hasIncome = entries.some((e) => e.kind === 'income');
  const hasRefund = entries.some((e) => e.amount < 0);

  async function send(body: Record<string, unknown>) {
    try {
      const done = await withRecalc((recalc) => api.post<{ changed: number }>(`${base}/entries/bulk`, { ids, ...body, recalc }));
      if (done === null) return;
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function apply() {
    const value = amount === '' ? undefined : parseMoney(amount);
    if (value !== undefined && (!value || value <= 0)) return setError('Введи сумму больше нуля или оставь поле пустым.');
    if (!dirty) return setError('Выбери, что изменить.');
    if (value !== undefined && !(await confirmAction(`Поставить сумму ${money(value)} всем отмеченным (${count})?`))) return;
    await send({ addTags, removeTags, ...(fund !== null ? { fundId: fund } : {}), ...(changeComment ? { comment } : {}), ...(value !== undefined ? { amount: value } : {}) });
  }

  async function remove() {
    if (!(await confirmAction(`Удалить отмеченные операции (${count})?`))) return;
    await send({ delete: true });
  }

  return (
    <div className="screen">
      <Header title={`Правка: ${count} шт.`} onBack={() => leaveForm(onClose)} />
      {error && <Banner kind="error">{error}</Banner>}
      <p className="muted small">Пустые поля не меняются. Если задеты закрытые месяцы, спрошу о пересчёте один раз на все.</p>
      <div className="field">
        <span>Добавить теги</span>
        <TagPicker value={addTags} options={tags.map((t) => t.name)} onChange={setAddTags} />
      </div>
      {present.length > 0 && (
        <div className="field">
          <span>Убрать теги</span>
          <div className="chips">
            {present.map((t) => {
              const on = removeTags.includes(t);
              return <button type="button" key={t} className={`chip${on ? ' selected' : ''}`} aria-pressed={on} onClick={() => setRemoveTags(on ? removeTags.filter((x) => x !== t) : [...removeTags, t])}>#{t}</button>;
            })}
          </div>
        </div>
      )}
      <div className="field">
        <span>Фонд</span>
        <FundTiles collapsible funds={funds} value={fund} allLabel="Не менять" onChange={setFund} />
        {hasIncome && fund !== null && <small className="muted">У доходов фонда нет, они останутся как есть.</small>}
      </div>
      <label className="check-row">
        <input type="checkbox" className="check" checked={changeComment} onChange={(e) => setChangeComment(e.target.checked)} />
        <span>Заменить комментарий</span>
      </label>
      {changeComment && <Field label="Комментарий" hint="Будет у всех отмеченных; пустой стирает комментарий. Описание из выписки остаётся."><input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} /></Field>}
      <Field label={`Сумма, ${symbol()}`} hint={hasRefund ? 'У возвратов сумма останется с минусом.' : undefined}>
        <input inputMode="decimal" placeholder="Не менять" value={amount} onChange={(e) => setAmount(numberInput(e.target.value))} />
      </Field>
      <div className="stack">
        <Button primary disabled={!dirty} onClick={apply}>Применить к {count} шт.</Button>
        <Button danger onClick={remove}>Удалить {count} шт.</Button>
      </div>
    </div>
  );
}

/** Выбор покупки, к которой относится возврат. Подставляет фонд и остаток суммы, если они ещё не заданы. */
export function RefundPicker({ base, value, fundId, exceptId, onChange }: {
  base: string;
  value: number | '';
  fundId: number | '';
  /** Сам возврат: его сумма в остатке покупки не считается */
  exceptId?: number;
  onChange: (id: number | '', original?: Refundable) => void;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const params = new URLSearchParams({
    ...(fundId ? { fundId: String(fundId) } : {}),
    ...(value ? { include: String(value) } : {}),
    ...(exceptId ? { except: String(exceptId) } : {}),
    ...(search ? { q: search } : {}),
  });
  const { data } = useLoad<Refundable[]>(`${base}/entries/refundable?${params}`);
  const label = (r: Refundable) =>
    `${dayMonth(r.date, true)} · ${r.comment || r.description || fundLabel(r.fundName) || 'покупка'} · ${money(r.amount)}${r.refunded ? `, осталось ${money(r.amount - r.refunded)}` : ''}`;
  return (
    <div className="field">
      <span>К какой покупке</span>
      <input type="search" aria-label="Найти покупку" placeholder="Найти покупку: магазин, сумма" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label="Покупка" value={value} onChange={(e) => {
        const id = e.target.value ? Number(e.target.value) : '';
        onChange(id, data?.find((r) => r.id === id));
      }}>
        <option value="">Без привязки</option>
        {data?.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
      </select>
      <small className="muted">{data && !data.length ? 'Подходящих покупок нет.' : 'Возврат погасит покупку: в списке будет видно, что она возвращена.'}</small>
    </div>
  );
}

type Kind = 'expense' | 'refund' | 'income';

/** Псевдофонд «Актив» в выборе фонда */
const ASSET = -1;

export function EntryForm({ base, ym, userId, isAdmin, entry, fundId, income, reminder, onClose }: { base: string; ym: string; userId: number; isAdmin: boolean; entry?: Entry; fundId: number | null; income?: boolean; reminder?: Reminder; onClose: () => void }) {
  const { data: funds } = useLoad<Fund[]>(`${base}/funds`);
  const { data: members } = useLoad<Member[]>(isAdmin ? `${base}/members` : null);
  const initialKind: Kind = entry ? (entry.kind === 'income' ? 'income' : entry.amount < 0 ? 'refund' : 'expense') : income ? 'income' : 'expense';
  const [kind, setKind] = useState<Kind>(initialKind);
  const [amount, setAmount] = useState(entry ? String(Math.abs(entry.amount) / 100) : reminder?.amount ? String(reminder.amount / 100) : '');
  // ASSET: расход по активу без фонда (агентские, нотариус), списывается прямо из свободных
  const [fund, setFund] = useState<number | ''>(entry ? (entry.fundId ?? (entry.potId ? ASSET : '')) : (reminder?.fundId ?? fundId ?? ''));
  const [date, setDate] = useState(entry?.date ?? reminder?.dueDate ?? defaultDate(ym));
  const [comment, setComment] = useState(entry?.comment ?? reminder?.comment ?? '');
  const [paidBy, setPaidBy] = useState<number | ''>(entry?.paidBy ?? '');
  const [pot, setPot] = useState<number | ''>(entry?.potId ?? '');
  // Активы для сопутствующих расходов; проданные тоже, чтобы видеть старые привязки
  const { data: pots } = useLoad<Pot[]>(`${base}/pots`);
  const assets = (pots ?? []).filter((p) => p.kind === 'asset');
  const [earnedBy, setEarnedBy] = useState<number | ''>(entry ? (entry.earnedBy ?? '') : userId);
  const { data: allTags } = useLoad<Tag[]>(`${base}/tags`);
  const [tags, setTags] = useState<string[]>(entry?.tags ?? []);
  const [frequent, setFrequent] = useState<string[]>([]);
  const tagsTouched = useRef(!!entry);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Операцию закрытого месяца сначала нужно явно открыть на правку
  const [unlocked, setUnlocked] = useState(!entry?.closed);
  const [refundOf, setRefundOf] = useState<number | ''>(entry?.refundOf?.id ?? '');

  // Подставленные автоматически теги изменением не считаются
  const snapshot = (over: { amount?: string; comment?: string; tags?: string[] } = {}) =>
    JSON.stringify([kind, over.amount ?? amount, fund, date, over.comment ?? comment, paidBy, earnedBy, pot, refundOf, over.tags ?? (tagsTouched.current ? tags : entry?.tags ?? [])]);
  // Та же проверка, что на сервере (affectsTotals): комментарий и привязка возврата итоги не меняют, о пересчёте не спрашивается
  const totalsKey = () => JSON.stringify([kind, parseMoney(amount), fund, date, paidBy, kind === 'income' ? earnedBy : '', pot, [...tags].map((t) => t.toLowerCase()).sort()]);
  const totalsBaseline = useRef(totalsKey());
  const recalcNeeded = !!entry?.closed && totalsKey() !== totalsBaseline.current;
  const baseline = useRef(snapshot());
  useUnsaved(snapshot() !== baseline.current);

  // Пока человек не трогал теги, они подставляются по похожим прошлым операциям (тот же продавец или сумма в фонде)
  useEffect(() => {
    // Ответ на устаревший запрос (фонд или сумму уже поменяли) не должен затереть свежий
    let stale = false;
    const timer = setTimeout(async () => {
      // Сумма помогает узнать повторяющийся платёж: подписку, садик, коммуналку
      const value = parseMoney(amount);
      const query = new URLSearchParams({ text: comment || entry?.description || '', ...(value ? { amount: String(value) } : {}), ...(kind === 'income' ? { kind } : fund && fund !== ASSET ? { fundId: String(fund) } : {}) });
      try {
        const res = await api.get<{ auto: string[]; frequent: string[] }>(`${base}/tags/suggest?${query}`);
        if (stale) return;
        setFrequent(res.frequent);
        if (!tagsTouched.current) setTags(res.auto);
      } catch {
        // Без подсказок форма работает как обычно
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [base, kind, fund, comment, amount]);

  async function save(andNext: boolean) {
    const value = parseMoney(amount);
    if (!value || value <= 0) return setError('Введи сумму больше нуля.');
    if (kind !== 'income' && !fund) return setError('Выбери фонд.');
    if (kind !== 'income' && fund === ASSET && !pot) return setError('Выбери актив.');
    const body = {
      date,
      kind: kind === 'income' ? 'income' : 'expense',
      amount: kind === 'refund' ? -value : value,
      fundId: kind === 'income' || fund === ASSET ? null : fund,
      description: entry?.description ?? '',
      comment,
      paidBy: paidBy === '' ? null : paidBy,
      earnedBy: kind !== 'income' || earnedBy === '' ? null : earnedBy,
      potId: kind === 'income' || fund !== ASSET || pot === '' ? null : pot,
      refundOf: kind === 'refund' && refundOf !== '' ? refundOf : null,
      tags,
      ...(reminder ? { reminderId: reminder.id } : {}),
    };
    try {
      const done = await withRecalc((recalc) => (entry ? api.put(`${base}/entries/${entry.id}`, { ...body, recalc }) : api.post(`${base}/entries`, { ...body, recalc })));
      if (done === null) return;
      setError(null);
      if (!andNext) return onClose();
      setSaved(`Сохранено: ${money(value)}`);
      setAmount('');
      setComment('');
      setTags([]);
      tagsTouched.current = false;
      baseline.current = snapshot({ amount: '', comment: '', tags: [] });
    } catch (e) {
      setSaved(null);
      setError((e as Error).message);
    }
  }

  async function remove() {
    if (!entry || !(await confirmAction('Удалить операцию?'))) return;
    try {
      if ((await withRecalc((recalc) => api.del(`${base}/entries/${entry.id}${recalc ? '?recalc=1' : ''}`))) === null) return;
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const kinds: [Kind, string][] = isAdmin ? [['expense', 'Расход'], ['refund', 'Возврат'], ['income', 'Доход']] : [['expense', 'Расход'], ['refund', 'Возврат']];

  return (
    <div className="screen">
      <Header title={entry ? 'Операция' : 'Новая операция'} onBack={() => leaveForm(onClose)} />
      {error && <Banner kind="error">{error}</Banner>}
      {saved && <Banner kind="ok">{saved}</Banner>}
      {!isAdmin && <Banner>Эта сумма добавится к тому, что база должна тебе.</Banner>}
      {entry?.closed && !unlocked && (
        <Banner>
          Месяц закрыт. Комментарий{kind === 'refund' ? ' и покупку для возврата' : ''} можно поправить сразу, итоги от них не меняются.{' '}
          {isAdmin ? 'Сумму, дату, фонд, теги и кто платил можно изменить после «Редактировать», тогда итоги этого и следующих месяцев пересчитаются.' : 'Остальное в закрытом месяце меняет администратор.'}
          {isAdmin && <div className="stack"><Button small onClick={() => setUnlocked(true)}>Редактировать</Button></div>}
        </Banner>
      )}
      {recalcNeeded && unlocked && <Banner kind="warn">После сохранения итоги закрытого месяца пересчитаются.</Banner>}
      <fieldset className="plain" disabled={!unlocked}>
      <Segmented value={kind} options={kinds} onChange={setKind} />
      <Field label={`Сумма, ${symbol()}`}><input className="amount" inputMode="decimal" autoFocus={!entry} value={amount} onChange={(e) => setAmount(numberInput(e.target.value))} placeholder="0" /></Field>
      {kind !== 'income' && (
        <div className="field">
          <span>Фонд</span>
          <FundTiles collapsible funds={[...(funds?.filter((f) => !f.archived || f.id === entry?.fundId) ?? []), ...(assets.length ? [{ id: ASSET, name: 'Актив' }] : [])]} value={fund} onChange={(id) => setFund(id ?? '')} />
        </div>
      )}
      {kind !== 'income' && fund === ASSET && (
        <Field label="Актив" hint="Расход по активу: агентские, нотариус, регистрация. Идёт не из фонда, а прямо из свободных; на стоимость актива не влияет, виден на экране актива.">
          <select value={pot} onChange={(e) => setPot(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Выбери актив</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Дата"><DateInput value={date} onChange={setDate} /></Field>
      </fieldset>
      <Field label="Комментарий"><input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} /></Field>
      {kind === 'refund' && (
        <RefundPicker
          base={base}
          value={refundOf}
          fundId={fund === ASSET ? '' : fund}
          exceptId={entry?.id}
          onChange={(id, original) => {
            setRefundOf(id);
            // Возврат идёт в тот же фонд, что и покупка; пустая сумма становится остатком покупки (поля закрытого месяца не трогаем)
            if (!original || !unlocked) return;
            if (!fund && original.fundId) setFund(original.fundId);
            if (!amount) setAmount(String((original.amount - original.refunded) / 100));
          }}
        />
      )}
      <fieldset className="plain" disabled={!unlocked}>
      {kind === 'income' && (
        <Field label="Чей доход">
          <select value={earnedBy} onChange={(e) => setEarnedBy(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Не указан</option>
            {members?.map((m) => <option key={m.userId} value={m.userId}>{memberLabel(m.name)}</option>)}
          </select>
        </Field>
      )}
      <div className="field">
        <span>Теги</span>
        <TagPicker value={tags} options={[...frequent, ...(allTags ?? []).map((t) => t.name)]} onChange={(next) => { tagsTouched.current = true; setTags(next); }} />
      </div>
      {isAdmin && kind !== 'income' && (
        <Field label="Кто платил" hint="Если своими деньгами платил участник, база будет должна ему эту сумму.">
          <select value={paidBy} onChange={(e) => setPaidBy(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Общие деньги</option>
            {members?.map((m) => <option key={m.userId} value={m.userId}>{memberLabel(m.name)}</option>)}
          </select>
        </Field>
      )}
      </fieldset>
      <div className="stack">
        <Button primary onClick={() => save(false)}>Сохранить</Button>
        {!entry && !reminder && <Button onClick={() => save(true)}>Сохранить и добавить ещё</Button>}
        {entry && <Button danger disabled={!unlocked} onClick={remove}>Удалить</Button>}
      </div>
    </div>
  );
}
