import { useEffect, useState } from 'react';
import { SettleScreen } from './settle';
import { ReminderForm, type Reminder } from './reminders';
import { api, startParam, telegram, useLoad, type Ledger, type Me } from './api';
import { BASE_CURRENCIES, setBaseCurrency, setEmojis } from './format';
import { confirmLeave, startBackNavigation, useBack } from './back';
import { Banner, Button, Field, Segmented, Spinner } from './ui';
import { EntriesScreen, EntryForm, type EntryKind, type EntryPeriod } from './entries';
import { HistoryScreen } from './history';
import { ImportScreen } from './imports';
import { MonthScreen, PlanScreen } from './month';
import { MoreScreen } from './more';
import { activeTheme, applyTheme, onSystemThemeChange } from './themes';

type Tab = 'month' | 'entries' | 'history' | 'base' | 'more';
type Overlay = { type: 'add'; reminder?: Reminder } | { type: 'reminder'; reminder?: Reminder } | { type: 'edit'; entry: any } | { type: 'import'; batchId?: number } | { type: 'plan' } | { type: 'settle' } | null;

const LEDGER_KEY = 'monzoid.ledger';

function readStored(): number | null {
  try {
    return Number(localStorage.getItem(LEDGER_KEY)) || null;
  } catch {
    return null;
  }
}

// Кнопка в уведомлении бота открывает приложение с параметром go_<экран>_<база>; остальные параметры это приглашения
const jump = /^go_(settle|entries)_(\d+)$/.exec(startParam ?? '');
const invite = jump ? undefined : startParam;
let jumped = false;
/** Экран из уведомления открывается один раз и только в той базе, о которой оно. */
function takeJump(ledgerId: number): 'settle' | 'entries' | null {
  if (!jump || jumped || Number(jump[2]) !== ledgerId) return null;
  jumped = true;
  return jump[1] as 'settle' | 'entries';
}

export function App() {
  const [inviteDone, setInviteDone] = useState(!invite);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [joined, setJoined] = useState<number | null>(null);

  useEffect(() => {
    telegram?.ready?.();
    telegram?.expand?.();
    startBackNavigation();
    if (!invite) return;
    api
      .post<{ ledgerId: number | null }>('/invites/accept', { token: invite })
      .then((r) => setJoined(r.ledgerId))
      .catch((e) => setInviteError(e.message))
      .finally(() => setInviteDone(true));
  }, []);

  const { data: me, error, reload } = useLoad<Me>(inviteDone ? '/me' : null);
  const [ledgerId, setLedgerId] = useState<number | null>(jump ? Number(jump[2]) : readStored());

  if (error) return <div className="screen"><Banner kind="error">{error}</Banner></div>;
  if (!me) return <Spinner />;

  const current = me.ledgers.find((l) => l.id === (joined ?? ledgerId)) ?? me.ledgers[0];
  const select = (id: number) => {
    setJoined(null);
    setLedgerId(id);
    try {
      localStorage.setItem(LEDGER_KEY, String(id));
    } catch {
      // Без хранилища просто откроется первая база
    }
  };

  if (!current && !me.canCreateLedger) {
    return (
      <div className="screen">
        <h1>Нужно приглашение</h1>
        {inviteError && <Banner kind="error">{inviteError}</Banner>}
        <p className="muted">В Monzoid можно войти только по приглашению. Попроси администратора базы прислать ссылку и открой её в Telegram.</p>
      </div>
    );
  }
  if (!current) {
    return <NewLedger currentYm={me.currentYm} inviteError={inviteError} onCreated={async (id) => { await reload(); select(id); }} />;
  }
  return (
    <LedgerApp
      key={current.id}
      ledger={current}
      me={me}
      inviteError={inviteError}
      onSwitch={select}
      onChanged={reload}
    />
  );
}

export function NewLedger({ currentYm, inviteError, onCreated, onCancel }: { currentYm: string; inviteError?: string | null; onCreated: (id: number) => void; onCancel?: () => void }) {
  const [name, setName] = useState('Семейный бюджет');
  const [startYm, setStartYm] = useState(currentYm);
  const [currency, setCurrency] = useState('KZT');
  const [people, setPeople] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function create() {
    try {
      const personalFunds = people.split(',').map((p) => p.trim()).filter(Boolean);
      const { id } = await api.post<{ id: number }>('/ledgers', { name, startYm, currency, personalFunds });
      onCreated(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="screen">
      <h1>Новая база</h1>
      {inviteError && <Banner kind="error">{inviteError}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      <Field label="Название"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Основная валюта" hint="Выбирается один раз: пересчёта базы в другую валюту пока нет.">
        <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {BASE_CURRENCIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </Field>
      <Field label="С какого месяца вести учёт"><input type="month" value={startYm} max={currentYm} onChange={(e) => setStartYm(e.target.value)} /></Field>
      <Field label="Личные фонды, через запятую" hint="Необязательно. Например: Иван, Анна"><input value={people} onChange={(e) => setPeople(e.target.value)} /></Field>
      <div className="row">
        <Button primary onClick={create}>Создать</Button>
        {onCancel && <Button onClick={onCancel}>Отмена</Button>}
      </div>
    </div>
  );
}

function LedgerApp({ ledger, me, inviteError, onSwitch, onChanged }: { ledger: Ledger; me: Me; inviteError: string | null; onSwitch: (id: number) => void; onChanged: () => Promise<void> }) {
  setBaseCurrency(ledger.currency);
  setEmojis(ledger.fundEmojis ?? {}, ledger.memberEmojis ?? {}, me.user.fundEmoji ?? true, me.user.memberEmoji ?? true);
  // Схема по режиму; в режиме «Системная» меняется вслед за устройством, без перезапуска
  useEffect(() => {
    const apply = () => applyTheme(activeTheme(me.user), me.user.design, ledger.locked);
    apply();
    return me.user.themeMode === 'system' ? onSystemThemeChange(apply) : undefined;
  }, [me.user.theme, me.user.themeNight, me.user.themeMode, me.user.design, ledger.locked]);
  const [initial] = useState(() => takeJump(ledger.id));
  const [tab, setCurrentTab] = useState<Tab>(initial === 'entries' ? 'entries' : 'month');
  const [tabHistory, setTabHistory] = useState<Tab[]>([]);
  // Нижняя кнопка «Месяц» открывает ту подвкладку, где были в последний раз
  const [monthSub, setMonthSub] = useState<'month' | 'entries'>(initial === 'entries' ? 'entries' : 'month');
  useEffect(() => {
    if (tab === 'month' || tab === 'entries') setMonthSub(tab);
  }, [tab]);
  const setTab = (next: Tab) => {
    if (next === tab) return;
    setTabHistory((h) => [...h, tab]);
    setCurrentTab(next);
  };
  // Месяц общий для экранов «Месяц» и «Операции»: от первого месяца базы до текущего
  const [ym, setMonth] = useState(me.currentYm < ledger.startYm ? ledger.startYm : me.currentYm);
  const setYm = (next: string) => setMonth(next < ledger.startYm ? ledger.startYm : next > me.currentYm ? me.currentYm : next);
  const [fundFilter, setFundFilter] = useState<number | null>(null);
  const [entryPeriod, setEntryPeriod] = useState<EntryPeriod>({ mode: 'month', from: ym, to: ym });
  const [entryKind, setEntryKind] = useState<EntryKind>('all');
  const [overlay, setOverlay] = useState<Overlay>(initial === 'settle' ? { type: 'settle' } : null);
  const [version, setVersion] = useState(0);
  // Пока в списке отмечают операции, круглые кнопки спрятаны: внизу панель отмеченных
  const [selecting, setSelecting] = useState(false);

  const base = `/ledgers/${ledger.id}`;
  const isAdmin = ledger.role === 'admin';
  const refresh = () => setVersion((v) => v + 1);
  const closeOverlay = () => {
    setOverlay(null);
    refresh();
  };

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [overlay, tab]);

  useBack(!!overlay || tabHistory.length > 0, 0, async () => {
    if (overlay) {
      if (await confirmLeave()) closeOverlay();
      return;
    }
    setCurrentTab(tabHistory[tabHistory.length - 1]);
    setTabHistory((h) => h.slice(0, -1));
  });

  if (overlay?.type === 'add' || overlay?.type === 'edit') {
    return <EntryForm base={base} ym={ym} userId={me.user.id} isAdmin={isAdmin} entry={overlay.type === 'edit' ? overlay.entry : undefined} fundId={fundFilter} income={tab === 'entries' && entryKind === 'income'} reminder={overlay.type === 'add' ? overlay.reminder : undefined} onClose={closeOverlay} />;
  }
  if (overlay?.type === 'reminder') {
    return <ReminderForm base={base} reminder={overlay.reminder} onClose={closeOverlay} />;
  }
  if (overlay?.type === 'import') {
    return <ImportScreen base={base} isAdmin={isAdmin} batchId={overlay.batchId} onClose={closeOverlay} onChanged={onChanged} />;
  }
  if (overlay?.type === 'settle') {
    return <SettleScreen base={base} ym={me.currentYm} isAdmin={isAdmin} onClose={closeOverlay} />;
  }
  if (overlay?.type === 'plan') {
    return <PlanScreen base={base} ym={ym} onClose={closeOverlay} />;
  }

  return (
    <div className="app">
      <div className="screen">
        {inviteError && <Banner kind="error">{inviteError}</Banner>}
        {ledger.locked && <Banner kind="warn">База заблокирована: можно только смотреть. Снять блокировку: База → Настройки базы.</Banner>}
        {/* «Месяц» и «Операции» на одной вкладке: переключатель сверху */}
        {(tab === 'month' || tab === 'entries') && (
          <div className="sticky-head">
            <Segmented value={tab} options={[['month', 'Месяц'], ['entries', 'Операции']]} onChange={setTab} />
          </div>
        )}
        {tab === 'month' && (
          <MonthScreen
            key={version}
            base={base}
            ledgerName={ledger.name}
            userId={me.user.id}
            ym={ym}
            currentYm={me.currentYm}
            onYm={setYm}
            onFund={(id) => { setFundFilter(id); setTab('entries'); }}
            onPlan={() => setOverlay({ type: 'plan' })}
            onImport={(batchId) => setOverlay({ type: 'import', batchId })}
            onSettle={() => setOverlay({ type: 'settle' })}
          />
        )}
        {tab === 'entries' && (
          <EntriesScreen key={version} base={base} ym={ym} onYm={setYm} period={entryPeriod} onPeriod={setEntryPeriod} kind={entryKind} onKind={setEntryKind} startYm={ledger.startYm} currentYm={me.currentYm} userId={me.user.id} isAdmin={isAdmin} locked={ledger.locked} fundId={fundFilter} onFund={setFundFilter} onSelecting={setSelecting} onEdit={(entry) => setOverlay({ type: 'edit', entry })} onReminder={(reminder) => setOverlay({ type: 'reminder', reminder })} onConfirm={(reminder) => setOverlay({ type: 'add', reminder })} />
        )}
        {tab === 'history' && <HistoryScreen key={version} base={base} startYm={ledger.startYm} currentYm={me.currentYm} isAdmin={isAdmin} currency={ledger.currency} />}
        {tab === 'base' && <MoreScreen key={`base${version}`} section="base" base={base} ledger={ledger} me={me} onSwitch={onSwitch} onChanged={onChanged} />}
        {tab === 'more' && <MoreScreen key={version} section="app" base={base} ledger={ledger} me={me} onSwitch={onSwitch} onChanged={onChanged} />}
      </div>
      {(tab === 'month' || (tab === 'entries' && !selecting)) && !ledger.locked && (
        <>
          {/* Расчёты с участниками: рядом с плюсом, чтобы не искать в «Базе» */}
          <button className="fab fab-third" aria-label="Запланировать платёж" onClick={() => setOverlay({ type: 'reminder' })}>⏰</button>
          <button className="fab fab-settle" aria-label="Расчёты с участниками" onClick={() => setOverlay({ type: 'settle' })}>⇄</button>
          <button className="fab" aria-label="Добавить операцию" onClick={() => setOverlay({ type: 'add' })}>+</button>
        </>
      )}
      <nav className="tabs">
        {([['month', 'Месяц'], ['history', 'Статистика'], ['base', 'База'], ['more', 'Ещё']] as [Tab, string][]).map(([id, label]) => {
          const active = id === 'month' ? tab === 'month' || tab === 'entries' : tab === id;
          return <button key={id} className={active ? 'active' : ''} onClick={() => (id === 'month' ? !active && setTab(monthSub) : setTab(id))}>{label}</button>;
        })}
      </nav>
    </div>
  );
}
