import { useEffect, useRef, useState } from 'react';
import { api, confirmAction, useLoad, withRecalc, type Fund, type ImportBatch, type ImportRow, type IncomeCategoryOption, type Member, type QueuedStatement, type SentImport, type Tag } from './api';
import { leaveForm, useUnsaved } from './back';
import { numberInput, amount, dayMonth, memberLabel, money, monthName, parseMoney, signed, symbol, toInput } from './format';
import { TagPicker } from './tags';
import { RefundPicker } from './entries';
import { Banner, Button, FundTiles, Header, Segmented, Spinner } from './ui';

type Action = 'expense' | 'income' | 'settlement' | 'skip' | 'merge';

interface Part {
  fundId: number | '';
  amount: string;
  comment: string;
  /** Покупка, к которой привязан возврат; в старых черновиках поля нет */
  refundOf?: number | '';
}

interface Draft {
  action: Action;
  parts: Part[];
  comment: string;
  userId: number | '';
  tags: string[];
  earnedBy: number | '';
  /** С какой строкой слита (action = 'merge') */
  mergeInto: number | '';
}

export function ImportScreen({ base, isAdmin, batchId, onClose, onChanged }: { base: string; isAdmin: boolean; batchId?: number; onClose: () => void; onChanged: () => Promise<void> }) {
  const [id, setId] = useState(batchId);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsaved(!id && files.length > 0);

  async function upload() {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      files.forEach((f) => form.append('file', f));
      const res = await api.upload<{ id: number }>(`${base}/imports`, form);
      setId(res.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (id) return <Review base={base} isAdmin={isAdmin} batchId={id} onClose={onClose} onChanged={onChanged} />;

  return (
    <div className="screen">
      <Header title="Загрузка выписки" onBack={() => leaveForm(onClose)} />
      <p className="muted">PDF из Kaspi Gold или Freedom Bank. Можно выбрать сразу обе выписки: так переводы между своими картами найдутся автоматически. Сам файл не сохраняется.</p>
      {error && <Banner kind="error">{error}</Banner>}
      <label className="file-pick">
        <input type="file" accept="application/pdf,.pdf" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        {files.length ? files.map((f) => f.name).join(', ') : 'Выбрать файлы'}
      </label>
      <Button primary disabled={!files.length || busy} onClick={upload}>{busy ? 'Читаю выписку…' : 'Разобрать'}</Button>
    </div>
  );
}

function initialDraft(row: ImportRow, isAdmin: boolean, uploader: number): Draft {
  let action: Action = row.suggestedAction;
  if (!isAdmin && (action === 'income' || action === 'settlement')) action = 'skip';
  return {
    action,
    parts: [{ fundId: row.suggestedFundId ?? '', amount: row.baseAmount === null ? '' : toInput(Math.abs(row.baseAmount)), comment: '' }],
    comment: '',
    userId: row.suggestedUserId ?? '',
    tags: row.suggestedTags,
    // Обычно выписку загружает её владелец, поэтому доход сначала записан на него
    earnedBy: uploader,
    mergeInto: '',
  };
}

/**
 * Комментарий это знак, что операцию проверили глазами: без него легко отправить автоматическую подсказку как есть.
 * Пропуск, объединение и выплата (у неё нет поля комментария) не требуют комментария.
 */
function lacksComment(d: Draft): boolean {
  if (d.action === 'income') return !d.comment.trim();
  if (d.action !== 'expense') return false;
  return d.parts.length === 1 ? !(d.comment.trim() || d.parts[0].comment.trim()) : d.parts.some((p) => !p.comment.trim() && !d.comment.trim());
}

/** Сумма строки вместе со слитыми с ней, со знаком из выписки. */
function effectiveAmount(row: ImportRow, drafts: Record<number, Draft>, rows: ImportRow[]): number {
  return row.amount + rows.filter((r) => drafts[r.id]?.action === 'merge' && drafts[r.id].mergeInto === row.id).reduce((s, r) => s + r.amount, 0);
}

function isReady(row: ImportRow, d: Draft, blocked: boolean, drafts: Record<number, Draft>, rows: ImportRow[]): boolean {
  if (d.action === 'skip') return true;
  if (d.action === 'merge') {
    const target = rows.find((r) => r.id === d.mergeInto);
    return !!target && drafts[target.id]?.action === 'expense' && isReady(target, drafts[target.id], false, drafts, rows);
  }
  if (blocked) return false;
  const parts = d.parts.map((p) => parseMoney(p.amount));
  const amountsOk = parts.every((v) => v !== null && v > 0);
  if (d.action === 'income') return row.amount > 0 && amountsOk;
  if (d.action === 'settlement') return row.amount < 0 && d.userId !== '' && amountsOk;
  // Сумму операции в другой валюте человек может поправить, поэтому части сверяются только у своей валюты.
  // Одна часть в своей валюте берёт всю сумму сама, вместе со слитыми строками
  const effective = effectiveAmount(row, drafts, rows);
  if (effective === 0) return false;
  if (row.rate === 1 && d.parts.length === 1) return d.parts[0].fundId !== '';
  const whole = row.rate !== 1 || parts.reduce((s: number, v) => s + (v ?? 0), 0) === Math.abs(effective);
  return d.parts.every((p) => p.fundId !== '') && amountsOk && whole;
}

/** Привязка уходит только у возврата: если строку потом сделали расходом, она забывается. */
function refundOf(row: ImportRow, d: Draft, drafts: Record<number, Draft>, rows: ImportRow[], p: Part): number | null {
  return effectiveAmount(row, drafts, rows) > 0 && d.parts.length === 1 && p.refundOf ? p.refundOf : null;
}

function toDecision(row: ImportRow, d: Draft, drafts: Record<number, Draft>, rows: ImportRow[]) {
  if (d.action === 'skip') return { rowId: row.id, action: 'skip' };
  if (d.action === 'merge') return { rowId: row.id, action: 'merge', intoRowId: d.mergeInto };
  const amount = row.rate === 1 ? {} : { amount: parseMoney(d.parts[0].amount) };
  if (d.action === 'income') return { rowId: row.id, action: 'income', comment: d.comment, earnedBy: d.earnedBy === '' ? null : d.earnedBy, tags: d.tags, ...amount };
  if (d.action === 'settlement') return { rowId: row.id, action: 'settlement', userId: d.userId, ...amount };
  // Комментарий строки достаётся каждой части, у которой нет своего
  return {
    rowId: row.id,
    action: 'expense',
    tags: d.tags,
    parts:
      row.rate === 1 && d.parts.length === 1
        ? [{ fundId: d.parts[0].fundId, amount: Math.abs(effectiveAmount(row, drafts, rows)), comment: d.parts[0].comment || d.comment, refundOf: refundOf(row, d, drafts, rows, d.parts[0]) }]
        : d.parts.map((p) => ({ fundId: p.fundId, amount: parseMoney(p.amount), comment: p.comment || d.comment, refundOf: refundOf(row, d, drafts, rows, p) })),
  };
}

function Review({ base, isAdmin, batchId, onClose, onChanged }: { base: string; isAdmin: boolean; batchId: number; onClose: () => void; onChanged: () => Promise<void> }) {
  const { data, error, reload } = useLoad<ImportBatch>(`${base}/imports/${batchId}`);
  const { data: funds } = useLoad<Fund[]>(`${base}/funds`);
  const { data: members } = useLoad<Member[]>(isAdmin ? `${base}/members` : null);
  const { data: allTags } = useLoad<Tag[]>(`${base}/tags`);
  const { data: incomeOptions } = useLoad<IncomeCategoryOption[]>(isAdmin ? `${base}/incomes/category-options` : null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [sending, setSending] = useState(false);
  // Последний сохранённый на сервере черновик: сохраняем, только если он изменился
  const saved = useRef('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved');

  useEffect(() => {
    if (!data) return;
    // Сохранённые решения берутся как были, новые строки получают подсказки
    const stored = (data.draft ?? {}) as Record<string, Draft>;
    const initial = Object.fromEntries(
      data.rows.map((r) => [r.id, stored[r.id] ? { ...initialDraft(r, isAdmin, data.userId), ...stored[r.id] } : initialDraft(r, isAdmin, data.userId)]),
    );
    setDrafts(initial);
    saved.current = JSON.stringify(initial);
  }, [data, isAdmin]);

  // Черновик сохраняется при каждом изменении, с небольшой задержкой, пока человек печатает
  const draftJson = JSON.stringify(drafts);
  useEffect(() => {
    if (!data || draftJson === saved.current) return;
    setSaveState('saving');
    const timer = setTimeout(() => {
      api
        .put(`${base}/imports/${batchId}/draft`, { draft: drafts })
        .then(() => {
          saved.current = draftJson;
          setSaveState('saved');
        })
        .catch(() => setSaveState('failed'));
    }, 500);
    return () => clearTimeout(timer);
  }, [draftJson]);
  useUnsaved(saveState !== 'saved');

  const rows = data?.rows ?? [];
  const blockReason = (row: ImportRow): string | null => {
    const ym = row.date.slice(0, 7);
    if (data && ym < data.startYm) return `Учёт в базе начинается с месяца «${monthName(data.startYm)}»`;
    if (data?.closedMonths.includes(ym)) return `Месяц «${monthName(ym)}» закрыт`;
    return null;
  };
  const ready = rows.filter((r) => drafts[r.id] && isReady(r, drafts[r.id], !!blockReason(r), drafts, rows));
  const earliest = rows.map((r) => r.date.slice(0, 7)).sort()[0];
  const canMoveStart = isAdmin && !!data && !!earliest && earliest < data.startYm && data.closedMonths.length === 0;
  const hasEarly = !!data && !!earliest && earliest < data.startYm;
  const skipping = ready.filter((r) => drafts[r.id].action === 'skip').length;
  const merging = ready.filter((r) => drafts[r.id].action === 'merge').length;
  const posting = ready.length - skipping - merging;
  const uncommented = rows.filter((r) => drafts[r.id] && lacksComment(drafts[r.id])).length;
  const open = rows.length - ready.length;

  if (error) return <div className="screen"><Header title="Проверка" onBack={onClose} /><Banner kind="error">{error}</Banner></div>;
  if (!data || !funds) return <div className="screen"><Spinner /></div>;

  const activeFunds = funds.filter((f) => !f.archived);
  const update = (id: number, patch: Partial<Draft>) =>
    setDrafts((current) => {
      const next = { ...current, [id]: { ...current[id], ...patch } };
      // Первый выбранный фонд подставляется в незаполненные операции того же магазина
      const fundId = patch.parts?.length === 1 ? patch.parts[0].fundId : '';
      const source = rows.find((r) => r.id === id);
      // Так же и с тегами: операции того же магазина без тегов получают выбранные
      if (patch.tags?.length && source) {
        for (const r of rows) {
          const d = next[r.id];
          if (r.id !== id && r.details === source.details && d?.tags.length === 0) next[r.id] = { ...d, tags: patch.tags };
        }
      }
      if (fundId !== '' && source) {
        for (const r of rows) {
          const d = next[r.id];
          if (r.id !== id && r.details === source.details && d?.action === 'expense' && d.parts.length === 1 && d.parts[0].fundId === '') {
            next[r.id] = { ...d, parts: [{ ...d.parts[0], fundId }] };
          }
        }
      }
      return next;
    });
  const visible = rows.filter((r) => drafts[r.id] && (showSkipped || drafts[r.id].action !== 'skip' || r.suggestedAction !== 'skip'));
  const hiddenSkips = rows.filter((r) => drafts[r.id]?.action === 'skip' && r.suggestedAction === 'skip').length;
  // Причины автоматического пропуска одной строкой, чтобы скрытое было видно сразу
  const skipReasons = [...rows
    .filter((r) => drafts[r.id]?.action === 'skip' && r.suggestedAction === 'skip')
    .reduce((m, r) => {
      const h = r.hint ?? '';
      const reason = h.startsWith('Уже была') ? 'уже были в прошлых выписках'
        : h.startsWith('Банк провёл') ? 'проведены банком, уже учтены «в обработке»'
        : /перевод|Пополнение/i.test(h) ? 'переводы между своими счетами'
        : /отмена/i.test(h) ? 'покупка и её отмена'
        : 'другое';
      return m.set(reason, (m.get(reason) ?? 0) + 1);
    }, new Map<string, number>())
    .entries()];

  async function moveStart() {
    try {
      await api.patch(base, { startYm: earliest });
      setSaveError(null);
      await onChanged();
      await reload();
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  async function send() {
    if (open > 0) return;
    const warning = uncommented ? `Без комментария: ${uncommented}, их могли не проверить. ` : '';
    if (!(await confirmAction(`${warning}Отправить выписку в учёт? Внести: ${posting}${merging ? `, объединить: ${merging}` : ''}, пропустить: ${skipping}. Отправку можно будет отменить.`))) return;
    setSending(true);
    try {
      // Черновик сохраняется и при отправке: после отмены отправки вернётся ровно он
      await api.put(`${base}/imports/${batchId}/draft`, { draft: drafts });
      saved.current = draftJson;
      setSaveState('saved');
      await api.post(`${base}/imports/${batchId}/decide`, { decisions: ready.map((r) => toDecision(r, drafts[r.id], drafts, rows)) });
      setSaveError(null);
      await onChanged();
      onClose();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="screen with-footer">
      <Header title="Проверка выписки" onBack={() => leaveForm(onClose)} />
      {data.warnings.map((w) => <Banner key={w} kind="warn">{w}</Banner>)}
      {saveError && <Banner kind="error">{saveError}</Banner>}
      {rows.length === 0 && <Banner kind="ok">Новых операций нет.</Banner>}
      {hasEarly && (
        <Banner kind="warn">
          В выписке есть операции за {monthName(earliest)}, а учёт в базе начинается с месяца «{monthName(data.startYm)}». Такие операции пока нельзя внести.
          {canMoveStart ? ' Если начать учёт раньше, стартовые остатки будут относиться к началу нового первого месяца.' : ' Первый месяц уже нельзя сдвинуть.'}
        </Banner>
      )}
      {canMoveStart && <Button onClick={moveStart}>Начать учёт с месяца «{monthName(earliest)}»</Button>}

      {hiddenSkips > 0 && (
        <Banner kind="info">
          Отмечены «Пропустить» автоматически: {skipReasons.map(([reason, n]) => `${reason} (${n})`).join(', ')}. Если что-то из них нужно внести, открой и выбери фонд.{' '}
          <Button small onClick={() => setShowSkipped(!showSkipped)}>
            {showSkipped ? 'Скрыть пропускаемые' : `Показать пропускаемые: ${hiddenSkips}`}
          </Button>
        </Banner>
      )}

      <ul className="review-list">
        {visible.map((row) => (
          <ReviewCard
            key={row.id}
            base={base}
            row={row}
            draft={drafts[row.id]}
            funds={activeFunds}
            members={members ?? []}
            tagOptions={(allTags ?? []).map((t) => t.name)}
            incomeOptions={incomeOptions ?? []}
            baseCurrency={data.baseCurrency}
            isAdmin={isAdmin}
            ready={isReady(row, drafts[row.id], !!blockReason(row), drafts, rows)}
            blockReason={blockReason(row)}
            effective={effectiveAmount(row, drafts, rows)}
            mergedWith={rows.filter((r) => drafts[r.id]?.action === 'merge' && drafts[r.id].mergeInto === row.id)}
            mergeOptions={rows.filter((r) => r.id !== row.id && r.currency === data.baseCurrency && drafts[r.id]?.action === 'expense')}
            onChange={(patch) => update(row.id, patch)}
          />
        ))}
      </ul>

      {rows.length > 0 && (
        <div className="footer-bar">
          <div>
            <div>Внести: <b>{posting}</b>{merging > 0 && <> · объединить: <b>{merging}</b></>} · пропустить: <b>{skipping}</b></div>
            {uncommented > 0 && <small className="negative">Без комментария: {uncommented}. </small>}
            <small className="muted">
              {open > 0 ? `Не заполнено: ${open}. Отправить можно, когда заполнены все. ` : ''}
              {saveState === 'saving' ? 'Сохраняю черновик…' : saveState === 'failed' ? 'Черновик не сохранился, проверь связь.' : 'Черновик сохранён.'}
            </small>
          </div>
          <Button primary disabled={open > 0 || sending} onClick={send}>{sending ? 'Отправляю…' : 'Отправить'}</Button>
        </div>
      )}
    </div>
  );
}

function ReviewCard({ base, row, draft, funds, members, tagOptions, incomeOptions, baseCurrency, isAdmin, ready, blockReason, effective, mergedWith, mergeOptions, onChange }: {
  base: string;
  row: ImportRow;
  draft: Draft;
  funds: Fund[];
  members: Member[];
  tagOptions: string[];
  incomeOptions: IncomeCategoryOption[];
  baseCurrency: string;
  isAdmin: boolean;
  ready: boolean;
  blockReason: string | null;
  effective: number;
  mergedWith: ImportRow[];
  mergeOptions: ImportRow[];
  onChange: (patch: Partial<Draft>) => void;
}) {
  if (draft.action === 'merge') {
    const target = mergeOptions.find((r) => r.id === draft.mergeInto);
    return (
      <li className={`review-card merged ${ready ? '' : 'incomplete'}`}>
        <div className="entry-main">
          <span className="entry-title">{row.details || row.op}</span>
          <b className={row.amount > 0 ? 'positive' : ''}>{signed(row.amount)}</b>
        </div>
        <div className="muted small">{dayMonth(row.date)} · {row.bank === 'kaspi' ? 'Kaspi' : 'Freedom'} · {row.op}</div>
        <div className="hint small">
          {target ? <>Объединена с «{target.details || target.op}» за {dayMonth(target.date)}: сумма войдёт в ту операцию.</> : 'Операция, с которой объединяли, больше не расход. Выбери другую или отмени.'}
        </div>
        <Button small onClick={() => onChange({ action: 'expense', mergeInto: '' })}>Не объединять</Button>
      </li>
    );
  }
  const options: [Action, string][] = [['expense', effective > 0 ? 'Возврат' : 'Расход']];
  if (isAdmin && row.amount > 0) options.push(['income', 'Доход']);
  if (isAdmin && row.amount < 0 && /Перевод/.test(row.op)) options.push(['settlement', 'Выплата']);
  options.push(['skip', 'Пропустить']);

  const foreign = row.currency !== baseCurrency;
  const total = foreign ? Math.abs(row.baseAmount ?? 0) : Math.abs(effective);
  const allocated = draft.parts.reduce((s, p) => s + (parseMoney(p.amount) ?? 0), 0);
  const setPart = (i: number, patch: Partial<Part>) => onChange({ parts: draft.parts.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  function split() {
    const left = Math.max(total - allocated, 0);
    onChange({ parts: [...draft.parts, { fundId: '', amount: toInput(left), comment: '' }] });
  }

  return (
    <li className={`review-card ${draft.action === 'skip' ? 'skipped' : ''} ${ready ? '' : 'incomplete'}`}>
      <div className="entry-main">
        <span className="entry-title">{row.details || row.op}</span>
        <b className={row.amount > 0 ? 'positive' : ''}>{!foreign ? signed(row.amount) : `${row.amount > 0 ? '+' : ''}${row.amount / 100} ${row.currency}`}</b>
      </div>
      <div className="muted small">
        {dayMonth(row.date)} · {row.bank === 'kaspi' ? 'Kaspi' : 'Freedom'} · {row.op}
        {row.suggestionSource === 'ai' && draft.action === 'expense' && ' · фонд предложил AI'}
        {row.suggestionSource === 'history' && draft.action === 'expense' && ' · фонд по истории'}
      </div>
      {row.hint && <div className="hint small">{row.hint}</div>}
      {mergedWith.length > 0 && (
        <div className="hint small">
          Вместе с {mergedWith.map((r) => `«${r.details || r.op}» ${signed(r.amount)}`).join(', ')}: итого <b>{signed(effective)}</b>
        </div>
      )}
      {lacksComment(draft) && <div className="hint warn small">Нет комментария: проверь операцию и напиши, что это.</div>}
      {blockReason && draft.action !== 'skip' && <div className="hint small">{blockReason}. Пока можно только пропустить.</div>}
      <Segmented value={draft.action} options={options} onChange={(action) => onChange({ action })} />
      {foreign && draft.action !== 'skip' && (
        <>
          <div className="muted small">
            {row.rate !== null ? `По курсу ${amount(row.rate)} на ${dayMonth(row.rateDate!)}. Сумму можно поправить.` : 'Курса пока нет, укажи сумму сам.'}
          </div>
          {draft.parts.length === 1 && (
            <input aria-label="Сумма в основной валюте" inputMode="decimal" placeholder={`Сумма, ${symbol()}`} value={draft.parts[0].amount} onChange={(e) => setPart(0, { amount: numberInput(e.target.value) })} />
          )}
        </>
      )}

      {draft.action === 'expense' && (
        <>
          {draft.parts.map((part, i) => (
            <div className="part" key={i}>
              <FundTiles collapsible funds={funds} value={part.fundId} onChange={(id) => setPart(i, { fundId: id ?? '' })} />
              {draft.parts.length > 1 && (
                <div className="part-line">
                  <input aria-label="Сумма части" inputMode="decimal" value={part.amount} onChange={(e) => setPart(i, { amount: numberInput(e.target.value) })} />
                  <input aria-label="Комментарий части" placeholder="Что купили" value={part.comment} onChange={(e) => setPart(i, { comment: e.target.value })} />
                  <button type="button" className="icon" aria-label="Убрать часть" onClick={() => onChange({ parts: draft.parts.filter((_, j) => j !== i) })}>×</button>
                </div>
              )}
            </div>
          ))}
          {!foreign && draft.parts.length > 1 && allocated !== total && (
            <div className="hint small">Распределено {money(allocated)} из {money(total)}</div>
          )}
          <button type="button" className="link" onClick={split}>Разделить на фонды</button>
          {draft.parts.length === 1 && (
            <input aria-label="Комментарий" placeholder="Комментарий" value={draft.comment} onChange={(e) => onChange({ comment: e.target.value })} />
          )}
          {effective > 0 && draft.parts.length === 1 && (
            <RefundPicker
              base={base}
              value={draft.parts[0].refundOf ?? ''}
              fundId={draft.parts[0].fundId}
              onChange={(id, original) => setPart(0, { refundOf: id, ...(original && draft.parts[0].fundId === '' && original.fundId ? { fundId: original.fundId } : {}) })}
            />
          )}
          <TagPicker compact value={draft.tags} options={[...(row.tagHints ?? []), ...tagOptions]} onChange={(tags) => onChange({ tags })} />
        </>
      )}
      {!foreign && draft.action !== 'skip' && mergeOptions.length > 0 && (
        <select className="merge-pick" aria-label="Объединить с другой операцией" value="" onChange={(e) => e.target.value && onChange({ action: 'merge', mergeInto: Number(e.target.value) })}>
          <option value="">Объединить с другой операцией…</option>
          {mergeOptions.map((r) => <option key={r.id} value={r.id}>{dayMonth(r.date)} · {r.details || r.op} · {signed(r.amount)}</option>)}
        </select>
      )}
      {draft.action === 'income' && (
        <>
          {incomeOptions.length > 0 && (
            <select aria-label="Категория дохода" value={incomeOptions.find((o) => draft.tags.includes(o.tag) && (o.earnedBy === null || o.earnedBy === draft.earnedBy))?.category ?? ''} onChange={(e) => {
              const option = incomeOptions.find((o) => o.category === e.target.value);
              // Категория это её тег; теги других категорий снимаются, зарплата заодно ставит, чей доход
              const others = new Set(incomeOptions.map((o) => o.tag));
              const tags = draft.tags.filter((t) => !others.has(t));
              onChange(option ? { tags: [option.tag, ...tags], ...(option.earnedBy !== null ? { earnedBy: option.earnedBy } : {}) } : { tags });
            }}>
              <option value="">Категория дохода</option>
              {incomeOptions.map((o) => <option key={o.category} value={o.category}>{o.category}</option>)}
            </select>
          )}
          <select aria-label="Чей доход" value={draft.earnedBy} onChange={(e) => onChange({ earnedBy: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">Чей доход: не указан</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{memberLabel(m.name)}</option>)}
          </select>
          <input aria-label="Комментарий" placeholder="Источник дохода" value={draft.comment} onChange={(e) => onChange({ comment: e.target.value })} />
          <TagPicker compact value={draft.tags} options={[...(row.tagHints ?? []), ...tagOptions]} onChange={(tags) => onChange({ tags })} />
        </>
      )}
      {draft.action === 'settlement' && (
        <select aria-label="Участник" value={draft.userId} onChange={(e) => onChange({ userId: e.target.value ? Number(e.target.value) : '' })}>
          <option value="">Кому выплата</option>
          {members.map((m) => <option key={m.userId} value={m.userId}>{memberLabel(m.name)}</option>)}
        </select>
      )}
    </li>
  );
}

const BANK_NAMES: Record<string, string> = { kaspi: 'Kaspi Gold', freedom: 'Freedom Bank' };
const shortDay = (iso: string) => dayMonth(iso, true);

/** Выписки, присланные боту. «Обработать» разбирает их все одной выпиской и открывает проверку. */
export function StatementQueue({ base, userId, onImport }: { base: string; userId: number; onImport: (batchId: number) => void }) {
  const { data, reload } = useLoad<QueuedStatement[]>(`${base}/queue`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data?.length) return null;

  async function process() {
    setBusy(true);
    setError(null);
    try {
      onImport((await api.post<{ id: number }>(`${base}/queue/process`)).id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function remove(q: QueuedStatement) {
    if (!(await confirmAction('Убрать выписку из очереди? Операции из неё не попадут в учёт.'))) return;
    try {
      await api.del(`${base}/queue/${q.id}`);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Banner kind="warn">
      <b>Выписки из бота ждут обработки</b>
      {error && <div className="negative small">{error}</div>}
      <ul className="queue-list">
        {data.map((q) => (
          <li key={q.id}>
            <span>
              {BANK_NAMES[q.bank] ?? q.bank}{q.account && ` *${q.account}`}
              <small className="muted">
                {' '}· {q.dateFrom && q.dateTo && (q.dateFrom === q.dateTo ? shortDay(q.dateFrom) : `${shortDay(q.dateFrom)}–${shortDay(q.dateTo)}`)} · {q.count} опер.
                {q.userId !== userId && q.userName && ` · ${q.userName}`}
              </small>
            </span>
            <button className="icon" aria-label="Убрать из очереди" onClick={() => void remove(q)}>×</button>
          </li>
        ))}
      </ul>
      <Button primary disabled={busy} onClick={process}>{busy ? 'Разбираю…' : data.length > 1 ? `Обработать ${data.length} выписки` : 'Обработать'}</Button>
    </Banner>
  );
}

/** Последние отправленные выписки: отправку можно отменить, тогда операции уйдут из учёта, а выписка вернётся в черновик. */
export function SentImports({ base, onChanged }: { base: string; onChanged: () => Promise<void> }) {
  const { data, error: loadError, reload } = useLoad<SentImport[]>(`${base}/imports/sent`);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function revert(b: SentImport) {
    if (!(await confirmAction(`Отменить отправку? ${b.posted} операций уйдут из учёта, а выписка вернётся в черновик с теми же решениями.`))) return;
    try {
      if ((await withRecalc((recalc) => api.post(`${base}/imports/${b.id}/revert`, { recalc }))) === null) return;
      setError(null);
      setDone('Выписка вернулась в черновик. Она ждёт проверки на экране «Месяц».');
      await Promise.all([reload(), onChanged()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <p className="muted small">Последние выписки, отправленные в учёт. Отмена отправки снимает их операции из учёта и возвращает выписку в черновик с теми же решениями.</p>
      {(error || loadError) && <Banner kind="error">{error ?? loadError}</Banner>}
      {done && <Banner kind="ok">{done}</Banner>}
      {!data && !loadError && <Spinner />}
      {data?.length === 0 && <p className="muted">Отправленных выписок пока нет.</p>}
      {!!data?.length && (
        <ul className="queue-list">
          {data.map((b) => (
            <li key={b.id}>
              <span>
                Отправлена {shortDay(b.sentAt.slice(0, 10))}: внесено {b.posted}{b.skipped > 0 && `, пропущено ${b.skipped}`}
                <small className="muted sent-files">{b.files.length === 1 ? b.files[0] : `${b.files.length} файла`}</small>
              </span>
              <button type="button" className="link" onClick={() => void revert(b)}>Вернуть в черновик</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
