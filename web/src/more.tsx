import { useState } from 'react';
import { ArchiveFund, archiveNote, restoreFund } from './archive';
import { AdjustmentsScreen } from './adjustments';
import { ChangesScreen } from './changes';
import { AppearanceScreen, SettingsScreen } from './settings';
import { NewLedger } from './App';
import { api, confirmAction, telegram, useLoad, type Fund, type Ledger, type Me, type Member, type Summary } from './api';
import { numberInput, dayMonth, fundLabel, memberLabel, money, parseMoney, today, toGroupedInput, toInput } from './format';
import { useBack } from './back';
import { SentImports } from './imports';
import { TagsManager } from './tags';
import { Banner, Button, Field, Header, Spinner } from './ui';

/** Вкладки «База» (всё про открытую базу) и «Ещё» (оформление, другие базы, приглашения). */
export function MoreScreen({ section, base, ledger, me, onSwitch, onChanged }: { section: 'base' | 'app'; base: string; ledger: Ledger; me: Me; onSwitch: (id: number) => void; onChanged: () => Promise<void> }) {
  const isAdmin = ledger.role === 'admin';
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<number | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const close = () => setPage(null);

  if (creating) {
    return <NewLedger currentYm={me.currentYm} onCancel={() => setCreating(false)} onCreated={async (id) => { await onChanged(); onSwitch(id); }} />;
  }

  if (managing !== null) return <MemberScreen base={base} userId={managing} onChanged={onChanged} onBack={() => setManaging(null)} />;

  if (page === 'changes') return <ChangesScreen base={base} onBack={close} />;
  if (page === 'adjustments') return <AdjustmentsScreen base={base} onBack={close} />;
  if (page === 'settings') return <SettingsScreen base={base} ledger={ledger} onChanged={onChanged} onBack={close} />;
  if (page === 'appearance') return <AppearanceScreen me={me} onChanged={onChanged} onBack={close} />;
  if (page === 'mine') return <SubPage title="Уведомления" onBack={close}><MyNotifications me={me} onChanged={onChanged} /></SubPage>;
  if (page === 'me') return <SubPage title="Я в этой базе" onBack={close}><MeInLedger base={base} ledgerName={ledger.name} me={me} onChanged={onChanged} /></SubPage>;
  if (page === 'members') return <SubPage title="Участники" onBack={close}><Members base={base} onManage={setManaging} /></SubPage>;
  if (page === 'funds') return <SubPage title="Фонды" onBack={close}><Funds base={base} onChanged={onChanged} /></SubPage>;
  if (page === 'imports') return <SubPage title="Отправленные выписки" onBack={close}><SentImports base={base} onChanged={onChanged} /></SubPage>;
  if (page === 'tags') return <SubPage title="Теги" onBack={close}><TagsManager base={base} /></SubPage>;
  if (page === 'invite') return <SubPage title="Пригласить в сервис" onBack={close}><ServiceInvite /></SubPage>;
  if (page === 'backup') return <SubPage title="Копии базы" onBack={close}><BackupSettings base={base} /></SubPage>;
  if (page === 'ledgers') {
    return (
      <SubPage title="Мои базы" onBack={close}>
        <ul className="simple-list">
          {me.ledgers.map((l) => (
            <li key={l.id}>
              <span className={l.locked ? 'muted' : undefined}>{l.name}{l.locked && <small> · заблокирована</small>}{l.id === ledger.id && <small className="muted"> · открыта</small>}</span>
              {l.id !== ledger.id && <Button small onClick={() => onSwitch(l.id)}>Открыть</Button>}
            </li>
          ))}
        </ul>
        <Button onClick={() => setCreating(true)}>Создать новую базу</Button>
      </SubPage>
    );
  }

  const link = (to: Page, title: string, note?: string) => (
    <button type="button" className="section-link" onClick={() => setPage(to)}>
      <span>{title}{note && <small className="muted"> · {note}</small>}</span>
      <span className="muted" aria-hidden>›</span>
    </button>
  );
  if (section === 'base') {
    return (
      <>
        <h1>{ledger.name}</h1>
        {link('me', 'Я в этой базе')}
        {isAdmin && link('members', 'Участники')}
        {isAdmin && link('funds', 'Фонды')}
        {isAdmin && link('tags', 'Теги')}
        {isAdmin && link('adjustments', 'Корректировки и переносы')}
        {link('imports', 'Отправленные выписки')}
        {isAdmin && link('changes', 'Изменения закрытых месяцев')}
        {isAdmin && link('backup', 'Копии базы в Telegram')}
        {isAdmin && link('settings', 'Настройки базы', ledger.locked ? 'заблокирована' : undefined)}
      </>
    );
  }
  return (
    <>
      <h1>Ещё</h1>
      {link('mine', 'Уведомления', me.user.notify ? 'включены' : 'выключены')}
      {link('appearance', 'Оформление')}
      {link('ledgers', 'Мои базы', ledger.name)}
      {me.isOwner && link('invite', 'Пригласить в сервис')}
    </>
  );
}

type Page = 'mine' | 'me' | 'members' | 'funds' | 'tags' | 'imports' | 'adjustments' | 'changes' | 'settings' | 'appearance' | 'ledgers' | 'invite' | 'backup';

/** Настройки самого человека: уведомления (на все базы) и то, что он может менять о себе в открытой базе. */
/** Уведомления: личные, одни на все базы. */
function MyNotifications({ me, onChanged }: { me: Me; onChanged: () => Promise<void> }) {
  const { error, run } = useAction();
  const [access, setAccess] = useState<'allowed' | 'denied' | null>(null);
  // Без разрешения бот не может написать тому, кто ни разу не открывал с ним чат
  const askAccess = () => telegram?.requestWriteAccess?.((granted: boolean) => setAccess(granted ? 'allowed' : 'denied'));
  const setNotify = (notify: boolean) => {
    if (notify) askAccess();
    void run(async () => { await api.patch('/me', { notify }); await onChanged(); });
  };
  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      <label className="check-row">
        <input type="checkbox" checked={me.user.notify} onChange={(e) => setNotify(e.target.checked)} />
        <span>
          <b>Уведомления от бота</b>
          <div className="muted small">Выплаты тебе приходят сразу. Операции, которые за тебя внёс администратор (а администратору: которые внесли участники), приходят одним сообщением через 10 минут после последней. Бота нужно хоть раз запустить в Telegram. Это для всех баз.</div>
        </span>
      </label>
      {me.user.notify && telegram?.requestWriteAccess && <Button small onClick={askAccess}>Разрешить боту писать мне</Button>}
      {access === 'allowed' && <Banner kind="ok">Бот может присылать тебе сообщения.</Banner>}
      {access === 'denied' && <Banner kind="warn">Без разрешения сообщения не придут. Можно открыть чат с ботом и нажать «Старт».</Banner>}
    </>
  );
}

/** Что участник меняет о себе в открытой базе: эмодзи, скрытие личных расходов, уведомления по базе и выход из неё. */
function MeInLedger({ base, ledgerName, me, onChanged }: { base: string; ledgerName: string; me: Me; onChanged: () => Promise<void> }) {
  const { data, reload } = useLoad<Member[]>(`${base}/members`);
  const { data: funds } = useLoad<Fund[]>(`${base}/funds`);
  const { error, setError, run } = useAction(reload);
  const self = data?.find((m) => m.userId === me.user.id);
  const personal = funds?.find((f) => f.ownerUserId === me.user.id);
  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      {self && (
        <>
          <Field label="Эмодзи" hint="Показывается перед твоим именем, его же получает твой личный фонд.">
            <input className="emoji-field" maxLength={16} placeholder="—" defaultValue={self.emoji} onBlur={(e) => { const emoji = e.target.value.trim(); if (emoji !== self.emoji) void run(async () => { await api.patch(`${base}/members/${self.userId}`, { emoji }); await onChanged(); }); }} />
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={!!self.hidePersonal} disabled={!personal} onChange={(e) => { const hidePersonal = e.target.checked; void run(() => api.patch(`${base}/members/${self.userId}`, { hidePersonal })); }} />
            <span>
              <b>Скрывать личные расходы</b>
              <div className="muted small">{personal ? `Операции фонда «${personal.name}» видят только ты и администраторы. Суммы в итогах месяца остаются.` : 'У тебя нет личного фонда, его назначает администратор.'}</div>
            </span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={!!self.notify} onChange={(e) => { const notify = e.target.checked; void run(() => api.patch(`${base}/members/${self.userId}`, { notify })); }} />
            <span>
              <b>Уведомления по этой базе</b>
              <div className="muted small">{me.user.notify ? 'Операции, выплаты и напоминания о платежах из этой базы. Остальные базы не меняются.' : 'Сейчас уведомления выключены для всех баз: Ещё → Уведомления.'}</div>
            </span>
          </label>
          <div className="section-body plain">
            <Button small danger onClick={async () => {
              // Список участников после выхода уже не загрузить: сразу обновляем список баз
              try {
                const preview = await api.get<{ owed: number; heir: { name: string } | null; blocked: string | null }>(`${base}/leave`);
                if (preview.blocked) return setError(preview.blocked);
                const debt = preview.owed > 0 ? `Расчёты не закрыты: база должна тебе ${money(preview.owed)}. ` : preview.owed < 0 ? `Расчёты не закрыты: у тебя переплата ${money(-preview.owed)}. ` : '';
                const heir = preview.heir ? `Администратором станет ${preview.heir.name}. ` : '';
                const text = `Выйти из базы «${ledgerName}»? ${debt}${heir}Твой профиль со всей историей останется в базе без аккаунта, администратор сможет вести его вручную. Если снова войдёшь по приглашению, вернёшься в этот же профиль.`;
                if (!(await confirmAction(text))) return;
                await api.post(`${base}/leave`);
                await onChanged();
              } catch (e) {
                setError((e as Error).message);
              }
            }}>Выйти из базы</Button>
          </div>
        </>
      )}
    </>
  );
}

/** Подменю «Ещё»: заголовок с кнопкой назад и содержимое раздела. */
function SubPage({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  useBack(true, 1, onBack);
  return (
    <>
      <Header title={title} onBack={onBack} />
      <div className="section-body plain">{children}</div>
    </>
  );
}

function useAction(reload?: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    setError,
    run: async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError(null);
        await reload?.();
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
  };
}

interface Invite {
  token: string;
  link: string | null;
}

function shareInvite(invite: Invite, text: string) {
  if (invite.link && telegram?.openTelegramLink) {
    telegram.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(invite.link)}&text=${encodeURIComponent(text)}`);
  }
}

function ServiceInvite() {
  const { error, run } = useAction();
  const [invite, setInvite] = useState<Invite | null>(null);

  async function create() {
    await run(async () => {
      const res = await api.post<Invite>('/service-invites');
      setInvite(res);
      shareInvite(res, 'Приглашение в Monzoid: создай свою базу');
    });
  }

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      <p className="muted small">Человек сможет создать свою отдельную базу. Твои базы он не увидит. Ссылка одноразовая: её может принять один человек.</p>
      <Button onClick={create}>Пригласить создать свою базу</Button>
      {invite && <Banner>Ссылка действует 7 дней: <code>{invite.link ?? invite.token}</code></Banner>}
    </>
  );
}

type Backup = { enabled: boolean; days: number; lastSentAt: string | null; intervals: number[]; canSend: boolean };

const intervalLabel = (days: number) =>
  days === 1 ? 'каждый день' : days === 7 ? 'раз в неделю' : days === 14 ? 'раз в 2 недели' : days === 30 ? 'раз в месяц' : `раз в ${days} дня`;

/** Копия этой базы администраторам в личку от бота: расписание и отправка вручную */
function BackupSettings({ base }: { base: string }) {
  const { data, reload } = useLoad<Backup>(`${base}/backup`);
  const { error, run } = useAction(reload);
  const [sent, setSent] = useState<string | null>(null);
  if (!data) return <Spinner />;
  const next = data.enabled && data.lastSentAt ? new Date(Date.parse(data.lastSentAt) + data.days * 86_400_000) : null;
  const when = (d: Date) => d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      {sent && <Banner kind="ok">{sent}</Banner>}
      <p className="muted small">Бот присылает администраторам этой базы файл с её учётом в сжатом виде. Других баз в нём нет. Это запасная копия на случай, если сервер пропадёт. Храни её у себя и не пересылай.</p>
      <label className="check-row">
        <input type="checkbox" checked={data.enabled} onChange={(e) => { const enabled = e.target.checked; void run(() => api.patch(`${base}/backup`, { enabled })); }} />
        <span><b>Присылать копию по расписанию</b></span>
      </label>
      <Field label="Как часто">
        <select value={data.days} disabled={!data.enabled} onChange={(e) => { const days = Number(e.target.value); void run(() => api.patch(`${base}/backup`, { days })); }}>
          {data.intervals.map((d) => <option key={d} value={d}>{intervalLabel(d)}</option>)}
        </select>
      </Field>
      <p className="muted small">
        {data.lastSentAt ? `Последняя копия: ${when(new Date(data.lastSentAt))}.` : 'Копий ещё не было.'}
        {next && ` Следующая: около ${when(next)}.`}
      </p>
      <Button disabled={!data.canSend} onClick={() => run(async () => {
        await api.post(`${base}/backup/send`);
        setSent('Копия отправлена тебе в личку от бота.');
      })}>Отправить копию сейчас</Button>
      {!data.canSend && <p className="muted small">Бот не настроен на этом сервере.</p>}
    </>
  );
}

function Members({ base, onManage }: { base: string; onManage: (userId: number) => void }) {
  const { data, reload } = useLoad<Member[]>(`${base}/members`);
  const { error, run } = useAction(reload);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [virtualName, setVirtualName] = useState('');

  async function createInvite() {
    await run(async () => {
      const res = await api.post<Invite>(`${base}/invites`);
      setInvite(res);
      shareInvite(res, 'Приглашение в общий учёт');
    });
  }

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      <ul className="simple-list">
        {data?.map((m) => (
          <li key={m.userId} className="member-row">
            <div className="member-main">
              <div className="member-title">
                <div>{m.emoji ? `${m.emoji} ` : ''}{m.name}</div>
                <small className="muted">{m.account ?? 'Нет аккаунта Telegram'}</small>
              </div>
              <button type="button" className="member-status" onClick={() => onManage(m.userId)}>
                {m.userId < 0 ? 'без аккаунта' : m.role === 'admin' ? 'админ' : 'участник'} ›
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">Имя участника помогает узнавать переводы ему в выписке. Участник без аккаунта не может войти, но на него можно записывать доходы и расходы. Когда человек появится, свяжи его: вся история перейдёт к нему.</p>
      <div className="inline-form">
        <input aria-label="Имя участника без аккаунта" placeholder="Участник без аккаунта" value={virtualName} onChange={(e) => setVirtualName(e.target.value)} />
        <Button small onClick={async () => { if (await run(() => api.post(`${base}/members/virtual`, { name: virtualName }))) setVirtualName(''); }}>Добавить</Button>
      </div>
      <Button onClick={createInvite}>Пригласить участника</Button>
      {invite && <Banner>Ссылка действует 7 дней: <code>{invite.link ?? invite.token}</code></Banner>}
    </>
  );
}

function MemberScreen({ base, userId, onChanged, onBack }: { base: string; userId: number; onChanged: () => Promise<void>; onBack: () => void }) {
  const { data, reload } = useLoad<Member[]>(`${base}/members`);
  const { data: funds, reload: reloadFunds } = useLoad<Fund[]>(`${base}/funds`);
  const { error, run } = useAction(reload);
  const [invite, setInvite] = useState<Invite | null>(null);
  useBack(true, 2, onBack);

  if (!data) return <Spinner />;
  const member = data.find((m) => m.userId === userId);
  if (!member) return <><Header title="Участник" onBack={onBack} /><p className="muted">Этого участника уже нет в базе.</p></>;
  const others = data.filter((m) => m.userId > 0);

  async function linkByInvite() {
    await run(async () => {
      const res = await api.post<Invite>(`${base}/members/${userId}/link-invite`);
      setInvite(res);
      shareInvite(res, `Приглашение в общий учёт: ты в нём как ${member!.name}`);
    });
  }

  async function linkToMember(target: Member) {
    if (!(await confirmAction(`Передать всю историю «${member!.name}» участнику ${target.name}? Отменить это нельзя.`))) return;
    if (await run(() => api.post(`${base}/members/${userId}/link`, { userId: target.userId }))) onBack();
  }

  const personal = funds?.find((f) => f.ownerUserId === userId);
  const credited = !!personal && personal.creditUserId === userId;
  const STOP = 'Начисления открытых месяцев снимутся, закрытые останутся.';

  async function setPersonal(fundId: number | null) {
    if (credited && !(await confirmAction(`Фонд «${personal!.name}» перестанет быть личным. ${STOP}`))) return;
    await run(async () => {
      if (fundId) {
        // Сервер сам снимает прежний личный фонд; начисление переносим в новый
        await api.patch(`${base}/funds/${fundId}`, { ownerUserId: userId });
        if (credited) await api.patch(`${base}/funds/${fundId}`, { creditUserId: userId });
      } else if (personal) {
        await api.patch(`${base}/funds/${personal.id}`, { ownerUserId: null });
      }
      await reloadFunds();
      await onChanged();
    });
  }

  async function setCredit(on: boolean) {
    if (!personal) return;
    if (!on && !(await confirmAction(`Выключить начисления в фонд «${personal.name}»? ${STOP}`))) return;
    await run(async () => {
      await api.patch(`${base}/funds/${personal.id}`, { creditUserId: on ? userId : null });
      await reloadFunds();
    });
  }

  async function remove() {
    if (!(await confirmAction(`Убрать ${member!.name} из базы?`))) return;
    if (await run(() => api.del(`${base}/members/${userId}`))) onBack();
  }

  return (
    <>
      <Header title={member.name} onBack={onBack} />
      {error && <Banner kind="error">{error}</Banner>}
      <dl className="facts">
        <div><dt>Статус</dt><dd>{userId < 0 ? 'без аккаунта' : member.role === 'admin' ? 'админ' : 'участник'}</dd></div>
        <div><dt>Аккаунт</dt><dd>{member.account ?? 'нет'}</dd></div>
      </dl>
      <Field label="Имя в базе">
        <input defaultValue={member.name} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== member.name) { const name = e.target.value; void run(async () => { await api.patch(`${base}/members/${userId}`, { name }); await onChanged(); }); } }} />
      </Field>
      <Field label="Эмодзи" hint="Показывается перед именем, его же получает личный фонд участника.">
        <input className="emoji-field" maxLength={16} placeholder="—" defaultValue={member.emoji} onBlur={(e) => { const emoji = e.target.value.trim(); if (emoji !== member.emoji) void run(async () => { await api.patch(`${base}/members/${userId}`, { emoji }); await onChanged(); }); }} />
      </Field>
      <Field label="Личный фонд" hint="Фонд, который считается фондом участника: статистика «Люди», эмодзи участника. У участника один личный фонд.">
        <select value={personal?.id ?? ''} onChange={(e) => void setPersonal(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Нет</option>
          {funds?.filter((f) => !f.archived && (!f.ownerUserId || f.ownerUserId === userId)).map((f) => <option key={f.id} value={f.id}>{fundLabel(f.name)}</option>)}
        </select>
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={credited} disabled={!personal} onChange={(e) => void setCredit(e.target.checked)} />
        <span>
          <b>Начисление</b>
          <div className="muted small">{personal ? 'Каждый месяц сумма плана личного фонда сама попадает в долг базы перед участником, остаток фонда не копится. Начисления идут с текущего месяца.' : 'Сначала выбери личный фонд.'}</div>
        </span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={!!member.hidePersonal} disabled={!personal} onChange={(e) => { const hidePersonal = e.target.checked; void run(() => api.patch(`${base}/members/${userId}`, { hidePersonal })); }} />
        <span>
          <b>Скрывать личные расходы</b>
          <div className="muted small">{personal ? `Операции фонда «${personal.name}» видят только ${member.name} и администраторы. Суммы в итогах месяца остаются.` : 'Сначала выбери личный фонд.'}</div>
        </span>
      </label>
      {userId < 0 && (
        <>
          <h3>Связать с настоящим человеком</h3>
          <Button onClick={linkByInvite}>Ссылка для связи</Button>
          {invite && <Banner>Ссылка действует 7 дней: <code>{invite.link ?? invite.token}</code></Banner>}
          <select aria-label="Связать с участником" value="" onChange={(e) => { const target = others.find((r) => r.userId === Number(e.target.value)); if (target) void linkToMember(target); }}>
            <option value="">Связать с участником</option>
            {others.map((r) => <option key={r.userId} value={r.userId}>{r.name}</option>)}
          </select>
        </>
      )}
      {member.role !== 'admin' && <Button danger onClick={remove}>Убрать из базы</Button>}
    </>
  );
}

function Funds({ base, onChanged }: { base: string; onChanged: () => Promise<void> }) {
  const { data, reload } = useLoad<Fund[]>(`${base}/funds`);
  const { error, setError, run } = useAction(reload);
  const [name, setName] = useState('');
  const [archiving, setArchiving] = useState<Fund | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (archiving && data) {
    return <ArchiveFund base={base} fund={archiving} funds={data} onBack={() => setArchiving(null)} onDone={async () => { setArchiving(null); setNotice(`«${archiving.name}» в архиве. Вернуть можно кнопкой ↺.`); await reload(); await onChanged(); }} />;
  }
  function saveOpening(f: Fund, text: string) {
    const value = text.trim() === '' ? 0 : parseMoney(text);
    if (value === null) return setError(`Проверь сумму в фонде «${f.name}»`);
    if (value !== f.openingBalance) void run(() => api.patch(`${base}/funds/${f.id}`, { openingBalance: value }));
  }

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}
      <p className="muted small">Первая колонка: эмодзи фонда, его можно заменить или стереть. Колонка с суммой: сколько было накоплено в фонде на начало учёта в базе. Галочка: предупреждать, если фонд тратится быстрее нормы. Для разовых платежей, например садика, её лучше снять.</p>
      <ul className="plan-list funds-list">
        {data?.map((f) => (
          <li key={f.id} className={f.archived ? 'archived' : ''}>
            <input aria-label={`Эмодзи: ${f.name}`} className="emoji-input" maxLength={16} placeholder="—" defaultValue={f.emoji} onBlur={(e) => { const emoji = e.target.value.trim(); if (emoji !== f.emoji) void run(async () => { await api.patch(`${base}/funds/${f.id}`, { emoji }); await onChanged(); }); }} />
            <input aria-label="Название фонда" defaultValue={f.name} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== f.name) { const name = e.target.value; void run(async () => { await api.patch(`${base}/funds/${f.id}`, { name }); await onChanged(); }); } }} />
            <input aria-label={`Стартовый остаток: ${f.name}`} inputMode="decimal" placeholder="0" defaultValue={toGroupedInput(f.openingBalance)} onInput={(e) => { e.currentTarget.value = numberInput(e.currentTarget.value, { minus: true }); }} onBlur={(e) => saveOpening(f, e.target.value)} />
            <input type="checkbox" className="check" aria-label={`Предупреждать о темпе трат: ${f.name}`} checked={!!f.paceAlert} onChange={(e) => { const paceAlert = e.target.checked; void run(() => api.patch(`${base}/funds/${f.id}`, { paceAlert })); }} />
            <button className="icon" aria-label={f.archived ? 'Вернуть фонд' : 'В архив'} title={f.archived ? 'Вернуть' : 'В архив'} onClick={() => {
              if (!f.archived) return setArchiving(f);
              void run(async () => { const text = await restoreFund(base, f); if (text) { setNotice(text); await onChanged(); } });
            }}>{f.archived ? '↺' : '×'}</button>
            {!!f.archived && <small className="muted fund-archive-note">{archiveNote(f)}</small>}
          </li>
        ))}
      </ul>
      <div className="inline-form">
        <input aria-label="Новый фонд" placeholder="Новый фонд" value={name} onChange={(e) => setName(e.target.value)} />
        <Button small onClick={async () => { if (await run(() => api.post(`${base}/funds`, { name }))) setName(''); }}>Добавить</Button>
      </div>
    </>
  );
}

