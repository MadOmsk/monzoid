import { useState, type ReactNode } from 'react';
import { fundLabel, longDate, monthName, shiftYm } from './format';

export function Spinner() {
  return <div className="spinner" role="status">Загрузка…</div>;
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'error' | 'warn' | 'ok'; children: ReactNode }) {
  return <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</div>;
}

export function Button({ primary, danger, small, disabled, onClick, children }: { primary?: boolean; danger?: boolean; small?: boolean; disabled?: boolean; onClick?: () => unknown | Promise<unknown>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const className = ['btn', primary && 'primary', danger && 'danger', small && 'small'].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick?.();
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

/**
 * Поле даты (или даты со временем): показывает «5 октября 2026, пн» и открывает системный календарь.
 * Значение как у обычного поля: ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTЧЧ:ММ.
 */
export function DateInput({ value, onChange, min, max, disabled, label, withTime }: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  label?: string;
  withTime?: boolean;
}) {
  const day = value ? longDate(value.slice(0, 10)) : '';
  const text = day ? `${day}${withTime && value.length > 10 ? ` в ${value.slice(11, 16)}` : ''}` : 'Выбери дату';
  return (
    <span className="date-input">
      <span className={`date-text${day ? '' : ' muted'}`} aria-hidden>{text}</span>
      <input
        type={withTime ? 'datetime-local' : 'date'}
        aria-label={label ? `${label}: ${text}` : text}
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        // На компьютере календарь иначе открывается только по значку, а его не видно
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.();
          } catch {
            // Уже открыт или браузер не умеет
          }
        }}
      />
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group">
      {options.map(([id, label]) => (
        <button type="button" key={id} className={value === id ? 'active' : ''} aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Выбор фонда плитками. Со свойством collapsible сетка раскрывается по нажатию и закрывается после выбора. */
export function FundTiles({ funds, value, placeholder, allLabel, collapsible, onChange }: {
  funds: { id: number; name: string }[];
  value: number | '' | null;
  placeholder?: string;
  allLabel?: string;
  collapsible?: boolean;
  onChange: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const found = funds.find((f) => f.id === value)?.name;
  const selected = found ? fundLabel(found) : undefined;
  const choose = (id: number | null) => {
    setOpen(false);
    onChange(id);
  };
  return (
    <div className="fund-picker">
      {collapsible && (
        <button type="button" className="fund-current" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={selected || allLabel ? '' : 'muted'}>{selected ?? allLabel ?? placeholder ?? 'Выбери фонд'}</span>
          <span className="muted" aria-hidden>{open ? '▴' : '▾'}</span>
        </button>
      )}
      {(!collapsible || open) && (
        <div className="fund-tiles" role="group" aria-label="Фонд">
          {allLabel && <button type="button" className={!selected ? 'active' : ''} aria-pressed={!selected} onClick={() => choose(null)}>{allLabel}</button>}
          {funds.map((f) => (
            <button type="button" key={f.id} className={f.id === value ? 'active' : ''} aria-pressed={f.id === value} onClick={() => choose(f.id)}>{fundLabel(f.name)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MonthNav({ ym, onYm, min, max }: { ym: string; onYm: (ym: string) => void; min?: string; max?: string }) {
  const prev = shiftYm(ym, -1);
  const next = shiftYm(ym, 1);
  return (
    <div className="month-nav">
      <button type="button" aria-label="Предыдущий месяц" disabled={!!min && prev < min} onClick={() => onYm(prev)}>‹</button>
      <strong>{monthName(ym)}</strong>
      <button type="button" aria-label="Следующий месяц" disabled={!!max && next > max} onClick={() => onYm(next)}>›</button>
    </div>
  );
}

export function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="header">
      <button type="button" className="back" aria-label="Назад" onClick={onBack}>‹</button>
      <h1>{title}</h1>
    </div>
  );
}

// Выбранная вкладка и месяц статистики переживают уход на другие экраны, пока приложение открыто
const remembered = new Map<string, unknown>();
export function useRemembered<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (remembered.has(key) ? (remembered.get(key) as T) : initial));
  return [
    value,
    (next: T) => {
      remembered.set(key, next);
      setValue(next);
    },
  ];
}
