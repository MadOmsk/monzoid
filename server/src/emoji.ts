import { all, run, type Db } from './db.js';

// Эмодзи фонда по умолчанию: по началу слова в названии. Пустая строка значит «без эмодзи».
const RULES: [RegExp, string][] = [
  [/^(еда|продукт)/, '🛒'],
  [/^кафе|ресторан/, '☕'],
  [/^(заправ|азс|бенз|топлив)/, '⛽'],
  [/^(авто|машин)/, '🚗'],
  [/^такси/, '🚕'],
  [/^(коммун|к\/у|жкх)/, '💡'],
  [/^дом/, '🏠'],
  [/^быт/, '🧴'],
  [/^(садик|детск)/, '🧸'],
  [/^уч[её]б/, '📚'],
  [/^(медиц|мед|здоров|аптек)/, '💊'],
  [/^одежд/, '👕'],
  [/^стрижк/, '✂️'],
  [/^спорт/, '🏃'],
  [/^развлеч/, '🎉'],
  [/^(подписк|связь)/, '📱'],
  [/^электрон/, '💻'],
  [/^(билет|путешеств|отпуск)/, '✈️'],
  [/^подар/, '🎁'],
  [/^(прочее|разное)/, '📦'],
  [/^аренд/, '🔑'],
  [/^документ/, '📄'],
  [/^недвиж/, '🏢'],
  [/^личн/, '👤'],
  [/^инвест/, '📈'],
  [/^(копил|накоп)/, '🐷'],
];

export function defaultFundEmoji(name: string): string {
  const n = name.trim().toLowerCase();
  return RULES.find(([re]) => re.test(n))?.[1] ?? '';
}

/** Фондам, у которых эмодзи ещё не задан (NULL), ставит эмодзи по названию. Стёртый пользователем ('') не трогает. */
export function fillFundEmojis(db: Db): void {
  for (const f of all<{ id: number; name: string }>(db, 'SELECT id, name FROM funds WHERE emoji IS NULL')) {
    run(db, 'UPDATE funds SET emoji = ? WHERE id = ?', defaultFundEmoji(f.name), f.id);
  }
}

/** Ведущие эмодзи имени отдельно от остального: «🐻Иван» → ['🐻', 'Иван']. */
export function splitLeadingEmoji(name: string): [string, string] {
  const m = /^((?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D)+)\s*(.*)$/u.exec(name.trim());
  return m && m[2] ? [m[1], m[2]] : ['', name];
}

/** Эмодзи, записанные в начале имени участника, переносятся в отдельное поле. */
export function moveMemberEmojis(db: Db): void {
  for (const m of all<{ ledger_id: number; user_id: number; display_name: string }>(db, `SELECT ledger_id, user_id, display_name FROM members WHERE emoji = ''`)) {
    const [emoji, name] = splitLeadingEmoji(m.display_name);
    if (emoji) run(db, 'UPDATE members SET emoji = ?, display_name = ? WHERE ledger_id = ? AND user_id = ?', emoji, name, m.ledger_id, m.user_id);
  }
}
