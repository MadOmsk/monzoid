import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { startBackupSender, telegramDocumentSender } from './backup.js';
import { startBot, telegramSend } from './bot.js';
import { startNotices } from './notify.js';
import { openDb } from './db.js';
import { createMarketSource, startMarketUpdates } from './market.js';
import { createFundSuggester } from './statements/ai.js';

const here = dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === 'production';
const devAuth = process.env.DEV_AUTH === '1' && !production;
const botToken = process.env.BOT_TOKEN ?? '';

if (!botToken && !devAuth) {
  console.error('Не задан BOT_TOKEN. Для локального запуска без Telegram укажи DEV_AUTH=1.');
  process.exit(1);
}

const db = openDb(process.env.DB_PATH ?? resolve(here, '../../data/monzoid.db'));
const market = createMarketSource();

const ownerIds = (process.env.OWNER_TELEGRAM_IDS ?? '').split(',').map(Number).filter(Boolean);
const sendDocument = botToken ? telegramDocumentSender(botToken) : undefined;

const app = buildApp({
  db,
  market,
  botToken,
  botUsername: process.env.BOT_USERNAME?.replace(/^@/, ''),
  ownerIds,
  sendDocument,
  devAuth,
  suggestFunds: createFundSuggester(process.env.ANTHROPIC_API_KEY),
  webDist: resolve(here, '../../web/dist'),
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`Monzoid: http://localhost:${port}${devAuth ? ' (вход без Telegram включён)' : ''}`);
startMarketUpdates(db, market);
// Бот принимает выписки в личке; без токена (локальный запуск) не запускается
if (botToken && process.env.BOT_POLLING !== '0') startBot(db, botToken);
// Уведомления участникам о выплатах и операциях
if (botToken) startNotices(db, telegramSend(botToken, process.env.BOT_USERNAME?.replace(/^@/, '')));
// Копия базы владельцам в Telegram по расписанию из настроек (по умолчанию раз в неделю)
if (sendDocument && ownerIds.length) startBackupSender(db, sendDocument, ownerIds);
