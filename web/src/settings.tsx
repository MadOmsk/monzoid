import { useEffect, useState } from 'react';
import { api, type Ledger, type Me } from './api';
import { useBack } from './back';
import { today } from './format';
import { DAY_THEMES, DESIGNS, loadDesignFont, NIGHT_THEMES, systemIsDark, type ThemeMode } from './themes';
import { Banner, Button, Field, Header, Segmented } from './ui';

export function SettingsScreen({ base, ledger, onChanged, onBack }: { base: string; ledger: Ledger; onChanged: () => Promise<void>; onBack: () => void }) {
  const [name, setName] = useState(ledger.name);
  const [startYm, setStartYm] = useState(ledger.startYm);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useBack(true, 1, onBack);

  async function patch(body: object) {
    try {
      await api.patch(base, body);
      setError(null);
      await onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function save() {
    setSaved(await patch({ name, startYm }));
  }

  return (
    <>
      <Header title="Настройки базы" onBack={onBack} />
      {error && <Banner kind="error">{error}</Banner>}
      {saved && <Banner kind="ok">Сохранено</Banner>}

      <label className="check-row">
        <input type="checkbox" checked={ledger.locked} onChange={(e) => { setSaved(false); void patch({ locked: e.target.checked }); }} />
        <span>
          <b>Заблокировать базу</b>
          <div className="muted small">Можно только смотреть: операции, планы, вклады и настройки не меняются, начисления не создаются. Оформление меняется и в заблокированной базе.</div>
        </span>
      </label>

      <Field label="Название"><input value={name} disabled={ledger.locked} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Первый месяц учёта"><input type="month" value={startYm} max={today().slice(0, 7)} disabled={ledger.locked} onChange={(e) => setStartYm(e.target.value)} /></Field>
      <Field label="Основная валюта" hint="Выбирается при создании базы и не меняется."><input value={ledger.currency} disabled /></Field>
      <p className="muted small">Свободные средства на начало учёта задаются корректировкой первого месяца: «База» → «Корректировки».</p>
      <Button primary disabled={ledger.locked} onClick={save}>Сохранить</Button>
    </>
  );
}

/** Оформление: дизайн и цветовая схема. Личные, одни на все базы. */
export function AppearanceScreen({ me, onChanged, onBack }: { me: Me; onChanged: () => Promise<void>; onBack: () => void }) {
  const { theme, themeNight, themeMode, design } = me.user;
  const [error, setError] = useState<string | null>(null);
  useBack(true, 1, onBack);
  // Чтобы образцы дизайнов показывали свои шрифты
  useEffect(() => DESIGNS.forEach(([id]) => loadDesignFont(id)), []);

  async function patch(body: object) {
    try {
      await api.patch('/me', body);
      setError(null);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Header title="Оформление" onBack={onBack} />
      <p className="muted small">Оформление твоё личное и одно на все базы. Заблокированная база показывается серым шрифтом.</p>
      {error && <Banner kind="error">{error}</Banner>}

      <label className="check-row">
        <input type="checkbox" checked={me.user.fundEmoji} onChange={(e) => void patch({ fundEmoji: e.target.checked })} />
        <span>
          <b>Эмодзи у фондов</b>
          <div className="muted small">Показывать значок перед названием фонда. Значки меняются в «База» → «Фонды».</div>
        </span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={me.user.memberEmoji} onChange={(e) => void patch({ memberEmoji: e.target.checked })} />
        <span>
          <b>Эмодзи у участников</b>
          <div className="muted small">Показывать значок перед именем участника. Значок меняется в «База» → «Участники».</div>
        </span>
      </label>

      <h2>Дизайн</h2>
      <div className="theme-grid" role="group" aria-label="Дизайн">
        {DESIGNS.map(([id, title, hint]) => (
          <button
            type="button"
            key={id || 'default'}
            data-design={id || undefined}
            className={`theme-option design-option${design === id ? ' active' : ''}`}
            aria-pressed={design === id}
            onClick={() => void patch({ design: id })}
          >
            <span className="design-sample"><i className="pill" /><i className="pill short" /></span>
            <span>{title}</span>
            <small className="muted">{hint}</small>
          </button>
        ))}
      </div>

      <h2>Тема</h2>
      <Segmented<ThemeMode> value={themeMode} options={[['day', 'День'], ['night', 'Ночь'], ['system', 'Система'], ['telegram', 'Telegram']]} onChange={(mode) => void patch({ themeMode: mode })} />
      <p className="muted small">
        {themeMode === 'system'
          ? `Как на устройстве: днём дневная схема, ночью ночная. Сейчас ${systemIsDark() ? 'ночная' : 'дневная'}.`
          : themeMode === 'day' ? 'Всегда дневная схема.' : themeMode === 'night' ? 'Всегда ночная схема.' : 'Цвета из темы Telegram. Схемы ниже запомнятся для других режимов.'}
      </p>

      {/* Видны схемы, которые действуют в выбранном режиме; в «Telegram» обе, чтобы их можно было подготовить */}
      {themeMode !== 'night' && (
        <>
          <h2>Дневная схема</h2>
          <ThemeGrid themes={DAY_THEMES} value={theme} label="Дневная схема" onPick={(id) => void patch({ theme: id })} />
        </>
      )}
      {themeMode !== 'day' && (
        <>
          <h2>Ночная схема</h2>
          <ThemeGrid themes={NIGHT_THEMES} value={themeNight} label="Ночная схема" onPick={(id) => void patch({ themeNight: id })} />
        </>
      )}
    </>
  );
}

/** Образцы схем одного списка (дневные или ночные), от светлой к тёмной. */
function ThemeGrid({ themes, value, label, onPick }: { themes: [string, string][]; value: string; label: string; onPick: (id: string) => void }) {
  return (
    <div className="theme-grid" role="group" aria-label={label}>
      {themes.map(([id, title]) => (
        <button
          type="button"
          key={id || 'telegram'}
          data-theme={id || undefined}
          className={`theme-option${value === id ? ' active' : ''}`}
          aria-pressed={value === id}
          style={id ? undefined : { background: 'var(--tg-theme-secondary-bg-color, #f2f2f0)', color: 'var(--tg-theme-text-color, #16161a)' }}
          onClick={() => onPick(id)}
        >
          <span className="swatch" style={id ? undefined : { background: 'var(--tg-theme-bg-color, #ffffff)' }}>
            <i style={{ background: 'var(--series-1)' }} />
            <i style={{ background: 'var(--series-2)' }} />
            <i style={{ background: 'var(--series-3)' }} />
            <b style={id ? undefined : { background: 'var(--tg-theme-button-color, #2a78d6)' }} />
          </span>
          <span>{title}</span>
        </button>
      ))}
    </div>
  );
}
