import { all, get, type Db } from './db.js';
import { reminderAction } from './notify.js';
import { assignLedger, describe, enqueueStatement, queued } from './queue.js';
import { parseStatement, StatementError, type ParsedStatement } from './statements/parse.js';

/**
 * Бот принимает выписки в личке и ставит их в очередь базы. Обработка (разбор по фондам) только в приложении.
 * Telegram опрашивается через getUpdates: вебхук не нужен, порт 443 на сервере занят.
 */

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const POLL_SECONDS = 50;
const RETRY_MS = 5000;

const HELP = 'Пришли сюда PDF-выписку Kaspi Gold или Freedom Bank. Я разберу её и поставлю в очередь, а обработать её можно в приложении кнопкой «Обработать» на главном экране.';

interface TgUser {
  id: number;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
}

type Keyboard = { inline_keyboard: ({ text: string; callback_data: string } | { text: string; url: string })[][] };

/** Всё, что бот делает снаружи. В тестах подменяется. */
export interface BotIo {
  send(chatId: number, text: string, keyboard?: Keyboard): Promise<void>;
  edit(chatId: number, messageId: number, text: string): Promise<void>;
  answer(callbackId: string, text?: string): Promise<void>;
  download(fileId: string): Promise<Uint8Array>;
  parse?(data: Uint8Array): Promise<ParsedStatement>;
}

function writableLedgers(db: Db, userId: number) {
  return all<{ id: number; name: string }>(
    db,
    `SELECT l.id, l.name FROM ledgers l JOIN members m ON m.ledger_id = l.id
     WHERE m.user_id = ? AND m.inactive_at IS NULL AND l.locked = 0 ORDER BY l.id`,
    userId,
  );
}

const queuedText = (what: string, ledger: string) =>
  `Выписка ${what} отправлена в очередь в приложении, база «${ledger}». Чтобы разнести операции по фондам, открой приложение и нажми «Обработать».`;

export async function handleUpdate(db: Db, io: BotIo, update: TgUpdate): Promise<void> {
  const callback = update.callback_query;
  if (callback) {
    const [kind, rawId, rawLedger] = (callback.data ?? '').split(':');
    // Кнопки под напоминанием о платеже: r:<действие>:<платёж>
    if (kind === 'r') {
      const result = reminderAction(db, callback.from.id, Number(rawLedger), rawId);
      await io.answer(callback.id, result);
      if (callback.message) await io.edit(callback.message.chat.id, callback.message.message_id, `${callback.message.text ?? ''}

${result}`);
      return;
    }
    const item = kind === 'q' ? queued(db, Number(rawId)) : undefined;
    const ledger = writableLedgers(db, callback.from.id).find((l) => l.id === Number(rawLedger));
    if (!item || item.userId !== callback.from.id || item.ledgerId !== null || !ledger) {
      await io.answer(callback.id, 'Эта выписка уже в очереди или база недоступна.');
      return;
    }
    assignLedger(db, item.id, ledger.id);
    await io.answer(callback.id);
    if (callback.message) await io.edit(callback.message.chat.id, callback.message.message_id, queuedText(describe(item), ledger.name));
    return;
  }

  const message = update.message;
  if (!message?.from || message.chat.type !== 'private') return;
  const chat = message.chat.id;
  const userId = message.from.id;
  const doc = message.document;
  if (!doc) {
    await io.send(chat, HELP);
    return;
  }
  const name = doc.file_name ?? 'выписка.pdf';
  if (doc.mime_type !== 'application/pdf' && !/\.pdf$/i.test(name)) {
    await io.send(chat, 'Это не PDF. Пришли выписку Kaspi Gold или Freedom Bank в PDF.');
    return;
  }
  if ((doc.file_size ?? 0) > MAX_FILE_BYTES) {
    await io.send(chat, 'Файл больше 15 МБ, такую выписку я не приму.');
    return;
  }
  if (!get(db, 'SELECT 1 x FROM members WHERE user_id = ? AND inactive_at IS NULL', userId)) {
    await io.send(chat, 'Ты пока не участник ни одной базы. Открой приложение по приглашению, потом присылай выписки.');
    return;
  }
  const ledgers = writableLedgers(db, userId);
  if (!ledgers.length) {
    await io.send(chat, 'Все твои базы заблокированы. Сними блокировку в приложении: База → Настройки базы.');
    return;
  }

  let parsed: ParsedStatement;
  try {
    parsed = await (io.parse ?? parseStatement)(await io.download(doc.file_id));
  } catch (e) {
    await io.send(chat, e instanceof StatementError ? `Не получилось прочитать выписку: ${e.message}` : 'Не получилось прочитать выписку. Проверь, что это PDF из Kaspi Gold или Freedom Bank.');
    if (!(e instanceof StatementError)) console.error('Бот: выписка не разобрана', e);
    return;
  }
  if (!parsed.rows.length) {
    await io.send(chat, 'В выписке нет операций, в очередь она не поставлена.');
    return;
  }

  if (ledgers.length === 1) {
    const item = enqueueStatement(db, userId, name, parsed, ledgers[0].id);
    await io.send(chat, queuedText(describe(item), ledgers[0].name));
    return;
  }
  const item = enqueueStatement(db, userId, name, parsed, null);
  await io.send(chat, `Выписка ${describe(item)} прочитана. В какую базу её отправить?`, {
    inline_keyboard: ledgers.map((l) => [{ text: l.name, callback_data: `q:${item.id}:${l.id}` }]),
  });
}

function telegramIo(token: string): BotIo & { poll(offset: number): Promise<TgUpdate[]> } {
  const call = async <T>(method: string, body: object): Promise<T> => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((POLL_SECONDS + 10) * 1000),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  };
  return {
    send: async (chat_id, text, reply_markup) => void (await call('sendMessage', { chat_id, text, reply_markup })),
    edit: async (chat_id, message_id, text) => void (await call('editMessageText', { chat_id, message_id, text })),
    answer: async (callback_query_id, text) => void (await call('answerCallbackQuery', { callback_query_id, text })),
    download: async (file_id) => {
      const file = await call<{ file_path: string }>('getFile', { file_id });
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (!res.ok) throw new Error(`Telegram: файл не скачан (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
    poll: (offset) => call<TgUpdate[]>('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] }),
  };
}

/**
 * Отправка уведомления, без опроса. Кнопка открывает главное мини-приложение бота сразу на нужном экране
 * (параметр go_<экран>_<база> понимает клиент); без имени бота кнопки нет.
 */
export function telegramSend(token: string, botUsername?: string) {
  const io = telegramIo(token);
  return (n: { chatId: number; text: string; ledgerId: number; screen: string; reminderId?: number; repeating?: boolean }) => {
    const open = botUsername ? [[{ text: n.reminderId ? 'Подтвердить в Monzoid' : 'Открыть Monzoid', url: `https://t.me/${botUsername}?startapp=go_${n.screen}_${n.ledgerId}` }]] : [];
    const remind = n.reminderId
      ? [
          [{ text: 'Через час', callback_data: `r:h:${n.reminderId}` }, { text: 'Завтра', callback_data: `r:d:${n.reminderId}` }],
          n.repeating
            ? [{ text: 'Пропустить раз', callback_data: `r:s:${n.reminderId}` }, { text: 'Удалить совсем', callback_data: `r:x:${n.reminderId}` }]
            : [{ text: 'Удалить', callback_data: `r:x:${n.reminderId}` }],
        ]
      : [];
    const rows = [...open, ...remind];
    return io.send(n.chatId, n.text, rows.length ? { inline_keyboard: rows } : undefined);
  };
}

/** Опрос Telegram в фоне. Ошибка сети или одного сообщения не останавливает бота. */
export function startBot(db: Db, token: string): void {
  const io = telegramIo(token);
  let offset = 0;
  const loop = async () => {
    for (;;) {
      try {
        const updates = await io.poll(offset);
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handleUpdate(db, io, update);
          } catch (e) {
            console.error('Бот: сообщение не обработано', e);
          }
        }
      } catch (e) {
        console.error('Бот: нет связи с Telegram', (e as Error).message);
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  };
  void loop();
}
