import { useEffect, useRef } from 'react';
import { confirmAction, telegram } from './api';

// Экран регистрирует свой шаг назад. Срабатывает самый глубокий: у него наибольшая глубина
interface Handler {
  depth: number;
  run: () => void;
}

const EDGE_PX = 20;
const SWIPE_PX = 70;
const MAX_DRIFT_PX = 50;

const handlers = new Set<Handler>();

function sync() {
  if (handlers.size) telegram?.BackButton?.show?.();
  else telegram?.BackButton?.hide?.();
}

export function goBack(): boolean {
  const top = [...handlers].sort((a, b) => b.depth - a.depth)[0];
  top?.run();
  return !!top;
}

export function useBack(active: boolean, depth: number, run: () => void) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!active) return;
    const handler = { depth, run: () => latest.current() };
    handlers.add(handler);
    sync();
    return () => {
      handlers.delete(handler);
      sync();
    };
  }, [active, depth]);
}

let unsaved = 0;
let asking = false;

/** Пока форма изменена, выход спрашивает подтверждение, а Telegram подтверждает закрытие приложения. */
export function useUnsaved(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    unsaved += 1;
    telegram?.enableClosingConfirmation?.();
    return () => {
      unsaved -= 1;
      if (!unsaved) telegram?.disableClosingConfirmation?.();
    };
  }, [dirty]);
}

export async function confirmLeave(): Promise<boolean> {
  if (!unsaved) return true;
  // Повторный свайп не должен открывать второй вопрос поверх первого
  if (asking) return false;
  asking = true;
  try {
    return await confirmAction('Выйти без сохранения? Изменения пропадут.');
  } finally {
    asking = false;
  }
}

/** Выход из формы её собственной стрелкой. */
export async function leaveForm(close: () => void) {
  if (await confirmLeave()) close();
}

/** Подключает кнопку «Назад» Telegram и свайп от левого края экрана. */
export function startBackNavigation() {
  telegram?.BackButton?.onClick?.(goBack);
  // Иначе приложение сворачивается, когда страницу тянут вниз
  telegram?.disableVerticalSwipes?.();

  let start: { x: number; y: number } | null = null;
  window.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    const inTable = (e.target as Element | null)?.closest?.('.table-wrap');
    start = e.touches.length === 1 && touch.clientX <= EDGE_PX && !inTable ? { x: touch.clientX, y: touch.clientY } : null;
  }, { passive: true });
  window.addEventListener('touchend', (e) => {
    if (!start) return;
    const touch = e.changedTouches[0];
    if (touch.clientX - start.x >= SWIPE_PX && Math.abs(touch.clientY - start.y) <= MAX_DRIFT_PX) goBack();
    start = null;
  }, { passive: true });
}
