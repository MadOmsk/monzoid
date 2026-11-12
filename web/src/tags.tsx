import { useState } from 'react';
import { api, confirmAction, useLoad, type Tag } from './api';
import { Banner, Button, Segmented } from './ui';

const MAX_OPTIONS = 12;

function clean(text: string): string {
  return text.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Выбранные теги, поле для нового и подсказки. В компактном виде поле раскрывается по кнопке. */
export function TagPicker({ value, options, compact, onChange }: { value: string[]; options: string[]; compact?: boolean; onChange: (tags: string[]) => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(!compact);
  const query = clean(text);
  const rest = [...new Set(options)].filter((t) => !value.includes(t) && t.includes(query)).slice(0, MAX_OPTIONS);

  function add(raw: string) {
    const tag = clean(raw);
    if (tag && !value.includes(tag) && value.length < 10) onChange([...value, tag]);
    setText('');
  }

  return (
    <div className="tag-picker">
      <div className="chips">
        {value.map((tag) => (
          <button type="button" key={tag} className="chip selected" aria-label={`Убрать тег ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))}>#{tag} ×</button>
        ))}
        {!open && <button type="button" className="chip" onClick={() => setOpen(true)}>+ тег</button>}
      </div>
      {open && (
        <>
          <div className="inline-form">
            <input
              aria-label="Новый тег"
              placeholder="Свой тег"
              maxLength={30}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add(text);
                }
              }}
            />
            <Button small disabled={!query} onClick={() => add(text)}>Добавить</Button>
          </div>
          {rest.length > 0 && (
            <div className="chips">
              {rest.map((tag) => <button type="button" key={tag} className="chip" onClick={() => add(tag)}>#{tag}</button>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

type TagOrder = 'count' | 'rare' | 'name';

export function TagsManager({ base }: { base: string }) {
  const { data, reload } = useLoad<Tag[]>(`${base}/tags`);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<TagOrder>('count');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = (data ?? [])
    .filter((t) => !q || t.name.toLowerCase().includes(q))
    .sort((a, b) => (order === 'name' ? a.name.localeCompare(b.name, 'ru') : order === 'rare' ? a.count - b.count || a.name.localeCompare(b.name, 'ru') : b.count - a.count || a.name.localeCompare(b.name, 'ru')));

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      setError(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      <p className="muted small">Если переименовать тег в уже существующий, они объединятся. Удаление снимает тег с операций, суммы не меняются.</p>
      {data?.length === 0 && <p className="muted small">Тегов пока нет. Они появятся, когда ты внесёшь операцию с тегом.</p>}
      {!!data?.length && (
        <>
          <Segmented value={order} options={[['count', 'Частые'], ['rare', 'Редкие'], ['name', 'А–Я']]} onChange={setOrder} />
          <input type="search" aria-label="Найти тег" placeholder={`Найти среди ${data.length}`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </>
      )}
      {!!data?.length && !shown.length && <p className="muted small">Ничего не найдено.</p>}
      <ul className="simple-list tag-list">
        {shown.map((t) => (
          <li key={`${t.id}:${t.name}`}>
            <input aria-label="Название тега" maxLength={30} defaultValue={t.name} onBlur={(e) => { if (clean(e.target.value) && clean(e.target.value) !== t.name) void run(() => api.patch(`${base}/tags/${t.id}`, { name: e.target.value })); }} />
            <small className="muted">{t.count}</small>
            <button className="icon" aria-label={`Удалить тег ${t.name}`} onClick={async () => { if (await confirmAction(`Удалить тег «${t.name}»?`)) await run(() => api.del(`${base}/tags/${t.id}`)); }}>×</button>
          </li>
        ))}
      </ul>
    </>
  );
}
