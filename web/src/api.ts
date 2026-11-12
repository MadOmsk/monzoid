import { useCallback, useEffect, useState } from 'react';

const tg = (window as any).Telegram?.WebApp;

export const telegram = tg;
export const startParam: string | undefined = tg?.initDataUnsafe?.start_param;

// Локально приложение открывается без Telegram: /?devUser=1 (работает только при DEV_AUTH=1 на сервере)
const devUser = new URLSearchParams(location.search).get('devUser');

function authHeaders(): Record<string, string> {
  if (tg?.initData) return { Authorization: `tma ${tg.initData}` };
  if (devUser) return { 'X-Dev-User': devUser };
  return {};
}

async function request<T>(method: string, url: string, body?: unknown, form?: FormData): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? 'Сервер недоступен', res.status);
  return data as T;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Запрос, который в закрытом месяце спрашивает согласие на пересчёт и повторяется с ним. null: человек отказался. */
export async function withRecalc<T>(send: (recalc: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await send(false);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) throw e;
    if (!(await confirmAction(`${e.message} Сохранить и пересчитать?`))) return null;
    return send(true);
  }
}

export const api = {
  get: <T,>(url: string) => request<T>('GET', url),
  post: <T = any,>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T = any,>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T = any,>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T = any,>(url: string) => request<T>('DELETE', url),
  upload: <T = any,>(url: string, form: FormData) => request<T>('POST', url, undefined, form),
};

export function useLoad<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!url) return;
    try {
      setData(await api.get<T>(url));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [url]);
  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);
  return { data, error, reload };
}

export function confirmAction(message: string): Promise<boolean> {
  if (tg?.isVersionAtLeast?.('6.2')) return new Promise((resolve) => tg.showConfirm(message, resolve));
  return Promise.resolve(window.confirm(message));
}

export interface Ledger {
  id: number;
  name: string;
  startYm: string;
  currency: string;
  locked: boolean;
  role: 'admin' | 'member';
  displayName: string;
  /** Эмодзи фондов по названию, только непустые */
  fundEmojis: Record<string, string>;
  /** Эмодзи участников по имени в базе, только непустые */
  memberEmojis: Record<string, string>;
}
export interface Me {
  /** theme и design: личное оформление, одно на все базы */
  user: { id: number; name: string; theme: string; themeNight: string; themeMode: 'system' | 'day' | 'night' | 'telegram'; design: string; fundEmoji: boolean; memberEmoji: boolean; notify: boolean };
  ledgers: Ledger[];
  currentYm: string;
  canCreateLedger: boolean;
  isOwner: boolean;
}
export interface MonthFund {
  id: number;
  name: string;
  planned: number;
  spent: number;
  delta: number;
  balanceBefore: number;
  /** Переносы остатка за месяц: пришло минус ушло */
  moved: number;
  balanceAfter: number;
}
export interface MonthReport {
  ym: string;
  closed: boolean;
  income: number;
  plannedTotal: number;
  spentTotal: number;
  freeDelta: number;
  fundsDelta: number;
  adjustments: number;
  /** Переносы остатков в свободные минус из свободных */
  transfers: number;
  potMoves: number;
  assetMoves: number;
  /** Валютные вклады (без акций) по курсу на конец месяца */
  currencyAfter: number;
  /** Акции по котировкам на конец месяца */
  stocksAfter: number;
  currencyInvested: number;
  stocksInvested: number;
  cashInvested: number;
  /** Расходы по активам без фонда, списываются из свободных */
  assetCosts: number;
  freeBefore: number;
  freeAfter: number;
  fundsAfter: number;
  potsAfter: number;
  potsInvested: number;
  assetsAfter: number;
  assetsInvested: number;
  moneyAfter: number;
  totalAfter: number;
  funds: MonthFund[];
}
export interface Summary {
  report: MonthReport;
  startYm: string;
  lastClosed: string | null;
  isAdmin: boolean;
  debts: { userId: number; name: string; owed: number; settledUntil: string | null; /** С начислением в личный фонд: расчёты с ним регулярные */ credited: number }[];
  paceAlerts: PaceAlert[];
}
export interface Pot {
  id: number;
  name: string;
  kind: 'cash' | 'currency' | 'stock' | 'asset';
  currency: string;
  ticker: string | null;
  balance: number;
  units: number;
  price: number | null;
  value: number | null;
  rateDate: string | null;
  valuedAt?: string | null;
  /** Изменение цены за последний день с котировкой */
  day?: { gain: number; since: string } | null;
}
export interface AssetValue {
  id: number;
  date: string;
  value: number;
  comment: string;
  createdAt: string;
  userName: string | null;
}
export interface PaceAlert {
  fundId: number;
  name: string;
  checkpoint: number;
  day: number;
  spent: number;
  planned: number;
  runOutDay: number | null;
}
export interface Fund {
  id: number;
  name: string;
  emoji: string;
  openingBalance: number;
  archived: number;
  paceAlert: number;
  creditUserId: number | null;
  /** Как фонд архивировали: видно в списке и отменяется кнопкой «Вернуть» */
  archive?: { date: string; mode: 'keep' | 'move' | 'split'; targetName: string | null; balanceToName: string | null } | null;
  /** Чей это личный фонд */
  ownerUserId: number | null;
}
export interface Member {
  userId: number;
  role: string;
  name: string;
  emoji: string;
  account: string | null;
  /** Операции личного фонда скрыты от других участников, кроме администраторов */
  hidePersonal: number;
  /** Уведомления по этой базе включены */
  notify: number;
}
export interface Entry {
  id: number;
  date: string;
  kind: 'expense' | 'income';
  amount: number;
  fundId: number | null;
  fundName: string | null;
  /** Актив, к которому относится расход */
  potId: number | null;
  potName?: string | null;
  description: string;
  comment: string;
  paidBy: number | null;
  paidByName: string | null;
  createdBy: number;
  tags: string[];
  earnedBy: number | null;
  earnedByName: string | null;
  autoCredit: number;
  closed: boolean;
  /** Покупка, к которой привязан этот возврат */
  refundOf: { id: number; date: string; amount: number; note: string } | null;
  /** Сколько вернули по этой покупке привязанными возвратами */
  refunded: number;
}

/** Покупка, к которой можно привязать возврат */
export interface Refundable {
  id: number;
  date: string;
  amount: number;
  refunded: number;
  fundId: number | null;
  fundName: string | null;
  description: string;
  comment: string;
}
export interface IncomeRow {
  ym: string;
  userId: number | null;
  name: string | null;
  total: number;
  count: number;
}
/** Выписка, присланная боту и ждущая обработки */
export interface QueuedStatement {
  id: number;
  userId: number;
  userName: string | null;
  fileName: string;
  bank: string;
  account: string;
  dateFrom: string | null;
  dateTo: string | null;
  count: number;
}
/** Месяц участника: начисления и прочие траты за счёт базы, выплаты ему */
export interface MemberMonth {
  ym: string;
  userId: number;
  credit: number;
  spent: number;
  paid: number;
  /** Траты из личного фонда участника */
  fundSpent: number;
}
export interface MemberStats {
  members: { userId: number; name: string; fund: { id: number; name: string } | null }[];
  months: MemberMonth[];
  byFund: { userId: number; fundId: number; fundName: string; total: number; count: number }[];
}
export interface PotQuotes {
  /** Валюта цены: котировки акции или основная валюта базы для курса */
  currency: string;
  points: { date: string; price: number }[];
  moves: { id: number; date: string; amount: number; units: number; comment: string; price: number | null }[];
}

/** Запись до или после изменения; у корректировки нет фонда и вида. */
export interface ChangeState {
  date: string;
  amount: number;
  comment: string;
  tags: string[];
  kind?: 'expense' | 'income';
}

export interface ClosedChange {
  id: number;
  kind: 'entry' | 'adjustment' | 'asset_value' | 'pot_move';
  recordId: number;
  action: 'create' | 'update' | 'delete';
  before: ChangeState | null;
  after: ChangeState | null;
  fundBefore: string | null;
  fundAfter: string | null;
  createdAt: string;
  revertedAt: string | null;
  userName: string | null;
}

export interface Adjustment {
  id: number;
  date: string;
  amount: number;
  comment: string;
  closed: boolean;
  tags: string[];
}

export interface Tag {
  id: number;
  name: string;
  count: number;
}
export interface TagStats {
  rows: { ym: string; tagId: number; name: string; total: number; count: number }[];
  untagged: { ym: string; total: number }[];
  currentYm: string;
}
export interface ImportRow {
  id: number;
  bank: string;
  date: string;
  amount: number;
  currency: string;
  op: string;
  details: string;
  suggestedAction: 'expense' | 'income' | 'skip' | 'settlement';
  suggestedFundId: number | null;
  suggestedUserId: number | null;
  suggestionSource: string;
  hint: string;
  suggestedTags: string[];
  /** Теги похожих прошлых операций: показываются первыми */
  tagHints?: string[];
  baseAmount: number | null;
  rate: number | null;
  rateDate: string | null;
}
export interface ImportBatch {
  id: number;
  userId: number;
  files: string[];
  warnings: string[];
  startYm: string;
  baseCurrency: string;
  closedMonths: string[];
  rows: ImportRow[];
  /** Сохранённый черновик решений по строкам */
  draft: Record<string, unknown> | null;
}
export interface SentImport {
  id: number;
  files: string[];
  userId: number;
  sentAt: string;
  posted: number;
  skipped: number;
  pending: number;
}
export interface IncomeCategoryOption {
  category: string;
  tag: string;
  earnedBy: number | null;
  count: number;
}
