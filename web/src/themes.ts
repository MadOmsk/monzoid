import { telegram } from './api';

/** Цветовые схемы. Цвета в styles.css под [data-theme]. Цвета Telegram это отдельный режим, а не схема. */
// Порядок по яркости фона, от светлой к тёмной (относительная яркость по WCAG)
export const DAY_THEMES: [string, string][] = [
  ['sky', 'Небо'],
  ['mint', 'Мята'],
  ['peach', 'Персик'],
  ['sakura', 'Сакура'],
  ['sand', 'Песок'],
  ['lavender', 'Лаванда'],
  ['paper', 'Блокнот'],
];
export const NIGHT_THEMES: [string, string][] = [
  ['forest', 'Лес'],
  ['graphite', 'Графит'],
  ['ocean', 'Океан'],
  ['coffee', 'Кофе'],
  ['sunset', 'Закат'],
  ['unlocked', 'Сумерки'],
  ['aurora', 'Северное сияние'],
  ['midnight', 'Полночь'],
];
export type ThemeMode = 'system' | 'day' | 'night' | 'telegram';

/** Сейчас тёмное время по устройству: сначала тема Telegram, вне Telegram настройка системы. */
export function systemIsDark(): boolean {
  if (telegram?.colorScheme) return telegram.colorScheme === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Какая схема действует: дневная, ночная или по устройству. */
export function activeTheme(user: { theme: string; themeNight: string; themeMode: ThemeMode }): string {
  // Пустая схема: цвета Telegram
  if (user.themeMode === 'telegram') return '';
  const night = user.themeMode === 'night' || (user.themeMode === 'system' && systemIsDark());
  return night ? user.themeNight : user.theme;
}

/** Следит за сменой темы устройства или Telegram; возвращает отписку. */
export function onSystemThemeChange(fn: () => void): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', fn);
  telegram?.onEvent?.('themeChanged', fn);
  return () => {
    media?.removeEventListener?.('change', fn);
    telegram?.offEvent?.('themeChanged', fn);
  };
}

/** Дизайны: формы, шрифт и панель вкладок, под [data-design]. Сочетаются с любой цветовой схемой. */
export const DESIGNS: [string, string, string][] = [
  ['', 'Обычный', 'Системный шрифт, аккуратные скругления'],
  ['unlocked', 'Unlocked', 'Roboto Flex, кнопки-пилюли, плавающая панель'],
  ['mono', 'Моно', 'Моноширинный шрифт, прямые углы, чёткие рамки'],
  ['journal', 'Журнал', 'Шрифт с засечками, тонкие линии, без заливки'],
  ['soft', 'Мягкий', 'Nunito, крупные скругления, мягкие тени без рамок'],
  ['compact', 'Плотный', 'Inter, мелкий шрифт и узкие отступы: больше видно сразу'],
];

// Шрифт дизайна грузится, только когда дизайн выбран или показан в настройках
const FONTS: Record<string, string> = {
  unlocked: 'https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,100..1000&display=swap',
  mono: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..800&display=swap',
  journal: 'https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400..800&display=swap',
  soft: 'https://fonts.googleapis.com/css2?family=Nunito:wght@400..800&display=swap',
  compact: 'https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap',
};

export function loadDesignFont(design: string) {
  const href = FONTS[design];
  if (!href || document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

/** Ставит цветовую схему и дизайн на страницу и красит шапку Telegram под фон. Заблокированная база пишется серым. */
export function applyTheme(theme: string, design: string, locked = false) {
  const root = document.documentElement;
  if (locked) root.dataset.locked = '';
  else delete root.dataset.locked;
  loadDesignFont(design);
  if (design) root.dataset.design = design;
  else delete root.dataset.design;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  if (!telegram?.isVersionAtLeast?.('6.1')) return;
  if (!theme) {
    telegram.setHeaderColor?.('secondary_bg_color');
    telegram.setBackgroundColor?.('secondary_bg_color');
    return;
  }
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  telegram.setHeaderColor?.(bg);
  telegram.setBackgroundColor?.(bg);
}
