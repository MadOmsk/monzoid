import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  name: string;
  username?: string;
  startParam?: string;
}

const MAX_AGE_SECONDS = 24 * 60 * 60;

/** Проверка initData по алгоритму Telegram Mini Apps. Возвращает null, если подпись не сходится. */
export function verifyInitData(initData: string, botToken: string, nowSeconds = Date.now() / 1000): TelegramUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !botToken) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || nowSeconds - authDate > MAX_AGE_SECONDS) return null;

  try {
    const user = JSON.parse(params.get('user') ?? '');
    if (typeof user.id !== 'number') return null;
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `id${user.id}`;
    return { id: user.id, name, username: typeof user.username === 'string' ? user.username : undefined, startParam: params.get('start_param') ?? undefined };
  } catch {
    return null;
  }
}
