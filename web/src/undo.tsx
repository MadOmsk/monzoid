import { useEffect, useState } from 'react';
import { api, onLoggedChange, reloadAll, withRecalc } from './api';

/** Последняя запись, которую можно отменить: номера изменений журнала из заголовка X-Change-Id. */
interface Offer {
  base: string;
  ids: number[];
  text: string;
  key: number;
}

const SHOW_MS = 8000;
let listener: ((offer: Offer | null) => void) | null = null;
let counter = 0;

/** Вызывается из api.ts после успешной записи, если сервер записал её в историю изменений. */
function offerUndo(url: string, method: string, ids: number[]) {
  const ledger = url.match(/^\/ledgers\/(\d+)\//)?.[1];
  if (!ledger || !ids.length) return;
  const text = ids.length > 1 ? `Изменено записей: ${ids.length}` : method === 'DELETE' ? 'Удалено' : method === 'PUT' ? 'Изменено' : 'Сохранено';
  listener?.({ base: `/ledgers/${ledger}`, ids, text, key: ++counter });
}

/** Плашка «Сохранено · Отменить» над нижней панелью. Отмена идёт через историю изменений, по одной записи с конца. */
export function UndoToast() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listener = (next) => {
      setOffer(next);
      setError(null);
    };
    onLoggedChange(offerUndo);
    return () => {
      listener = null;
      onLoggedChange(null);
    };
  }, []);

  useEffect(() => {
    if (!offer || busy || error) return;
    const timer = setTimeout(() => setOffer(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [offer, busy, error]);

  if (!offer) return null;

  async function undo(current: Offer) {
    setBusy(true);
    try {
      for (const id of [...current.ids].reverse()) {
        if ((await withRecalc((recalc) => api.post(`${current.base}/changes/${id}/revert`, { recalc }))) === null) return;
      }
      setOffer(null);
      reloadAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="undo-toast" role="status" key={offer.key}>
      <span>{error ?? offer.text}</span>
      {error ? (
        <button type="button" onClick={() => setOffer(null)}>Закрыть</button>
      ) : (
        <button type="button" disabled={busy} onClick={() => undo(offer)}>Отменить</button>
      )}
    </div>
  );
}
