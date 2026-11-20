import { useState } from 'react';
import { amount, numberInput, parseMoney, parseUnits, symbol, toGroupedInput } from './format';

/** Поля сделки с валютой: сумма в основной валюте, курс за одну единицу и количество валюты. */
export type FxField = 'sum' | 'rate' | 'units';

/** Число для поля ввода без лишних нулей: «1 114,28». */
function decimalText(value: number, digits: number): string {
  return amount(Number(value.toFixed(digits)), digits);
}

/**
 * Два поля из трёх задаёт человек, третье считается: сумма = курс × количество.
 * Пока курс не трогали, он берётся с рынка (Нацбанк на дату). Поправить можно любое поле, в том числе посчитанное:
 * тогда оно становится заданным, а считаться начинает то, что задавали раньше всех.
 * fixedSum: сумма задана снаружи (вторая сторона перевода валюты в валюту), тут считаются только курс и количество.
 */
export function useFx(market: number | null, fixedSum?: number | null) {
  const [typed, setTyped] = useState<Record<FxField, string>>({ sum: '', rate: '', units: '' });
  // Заданные человеком поля, последнее в начале; считается поле, которого среди двух последних нет
  const [edited, setEdited] = useState<FxField[]>([]);
  const locked = fixedSum !== undefined;

  const own = edited.filter((f) => !locked || f !== 'sum');
  const anchors: FxField[] = locked ? ['sum', ...own.slice(0, 1)] : own.slice(0, 2);
  // Курс с рынка занимает место незаданного поля
  if (anchors.length < 2 && !anchors.includes('rate')) anchors.push('rate');
  if (anchors.length < 2) anchors.push(locked ? 'units' : 'sum');
  const computed = (['sum', 'rate', 'units'] as FxField[]).find((f) => !anchors.includes(f))!;

  const given = {
    sum: locked ? (fixedSum ?? null) : parseMoney(typed.sum),
    rate: edited.includes('rate') ? parseUnits(typed.rate) : market,
    units: parseUnits(typed.units),
  };
  const ok = (v: number | null): v is number => v !== null && v > 0;
  let sum = given.sum;
  let rate = given.rate;
  let units = given.units;
  if (computed === 'sum') sum = ok(rate) && ok(units) ? Math.round(rate * units * 100) : null;
  if (computed === 'units') units = ok(sum) && ok(rate) ? Math.round((sum / 100 / rate) * 100) / 100 : null;
  if (computed === 'rate') rate = ok(sum) && ok(units) ? sum / 100 / units : null;

  const shown = (f: FxField): string => {
    if (edited.includes(f) && f !== computed && !(locked && f === 'sum')) return typed[f];
    const v = f === 'sum' ? sum : f === 'rate' ? rate : units;
    if (!ok(v)) return '';
    return f === 'sum' ? toGroupedInput(v) : decimalText(v, f === 'rate' ? 4 : 2);
  };

  function type(f: FxField, text: string) {
    const clean = numberInput(text, { decimals: f === 'sum' ? 2 : f === 'rate' ? 6 : 8 });
    setTyped((t) => ({ ...t, [f]: clean }));
    setEdited((e) => (clean.trim() ? [f, ...e.filter((x) => x !== f)] : e.filter((x) => x !== f)));
  }

  return {
    computed,
    shown,
    type,
    /** Сумма в тиынах и количество валюты; null, пока не хватает данных */
    sum: ok(sum) ? sum : null,
    units: ok(units) ? units : null,
    rate: ok(rate) ? rate : null,
    marketUsed: !edited.includes('rate') && computed !== 'rate',
    reset() {
      setTyped({ sum: '', rate: '', units: '' });
      setEdited([]);
    },
  };
}

/** Три поля сделки с валютой. Посчитанное поле подписано «считается», его можно перебить. */
export function FxFields({ fx, currency, unitsLabel, showSum = true }: { fx: ReturnType<typeof useFx>; currency: string; unitsLabel: string; showSum?: boolean }) {
  const field = (f: FxField, label: string, decimals: string) => (
    <label className="field" key={f}>
      <span>{label}{fx.computed === f ? ' · считается' : f === 'rate' && fx.marketUsed ? ' · Нацбанк' : ''}</span>
      <input inputMode="decimal" placeholder={decimals} className={fx.computed === f ? 'auto' : undefined} value={fx.shown(f)} onChange={(e) => fx.type(f, e.target.value)} />
    </label>
  );
  return (
    <div className="fx-fields">
      {showSum && field('sum', `Сумма, ${symbol()}`, '0')}
      {field('rate', `Курс, ${symbol()} за 1 ${symbol(currency)}`, '0')}
      {field('units', `${unitsLabel}, ${symbol(currency)}`, '0')}
    </div>
  );
}
