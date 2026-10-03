import type { Dimension } from '@/lib/units';
import type { WeightDisplayUnit } from '@/lib/format/weight';
import type { DishIngredientUnit } from '@/lib/calculations/dish';

/**
 * Pure helpers for the Menu dish editor's quantity fields. The editor keeps every
 * quantity CANONICAL (grams / millilitres / count) in state and only converts what is
 * shown and typed, so the shared g/kg switch can be flipped any number of times
 * without drifting a quantity or a cost.
 */

/** Menu line quantities are numeric(12,4): canonical amounts keep 4 decimals. */
const CANONICAL_DECIMALS = 4;

const UNIT_FACTOR: Record<DishIngredientUnit, number> = { g: 1, kg: 1000, ml: 1, l: 1000, piece: 1 };

/** Rounds a canonical amount to the stored 4 decimals, dropping binary noise first. */
export function roundCanonical(amount: number): number {
  const scale = 10 ** CANONICAL_DECIMALS;
  return Math.round(Number((amount * scale).toPrecision(15))) / scale;
}

/**
 * A typed decimal: "1,5", "1.5", ",5", "15000" or "15 000". Commas and points are
 * both decimal separators; a value with both, a minus sign or letters is unreadable.
 * Returns null for blank or unreadable text.
 */
export function parseDecimal(text: string): number | null {
  const compact = text.trim().replace(/\s+/g, '');
  if (!/^(\d+([.,]\d*)?|[.,]\d+)$/.test(compact)) return null;
  const value = Number(compact.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** The unit a line is shown and typed in: weight follows the dish switch; ml/l and pieces keep their own. */
export function lineDisplayUnit(
  dimension: Dimension,
  storedUnit: DishIngredientUnit | null,
  displayUnit: WeightDisplayUnit,
): DishIngredientUnit {
  if (dimension === 'weight') return displayUnit;
  if (dimension === 'volume') return storedUnit === 'l' ? 'l' : 'ml';
  return 'piece';
}

/** Canonical amount → field text in `unit`, without trailing zeros (15000 g in kg → "15"). */
export function canonicalToField(canonical: number, unit: DishIngredientUnit): string {
  const value = canonical / UNIT_FACTOR[unit];
  // kg / l need 3 more decimals than g / ml to show the stored 4-decimal canonical exactly.
  const decimals = UNIT_FACTOR[unit] === 1 ? CANONICAL_DECIMALS : CANONICAL_DECIMALS + 3;
  let text = value.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

/** Field text in `unit` → canonical amount rounded to the stored precision; null when blank or unreadable. */
export function fieldToCanonical(text: string, unit: DishIngredientUnit): number | null {
  const value = parseDecimal(text);
  return value === null ? null : roundCanonical(value * UNIT_FACTOR[unit]);
}

/** The amount to send for a line saved in `unit` (the server multiplies back to canonical). */
export function canonicalToUnitAmount(canonical: number, unit: DishIngredientUnit): number {
  return canonical / UNIT_FACTOR[unit];
}

/**
 * A typed money amount → integer cents. Blank → null; unreadable or negative → NaN.
 * Accepts a decimal comma or point, and thousands separators when both appear (the
 * last one is the decimal): "3", "3,5", "1.234,56", "1,234.56".
 */
export function parseMoneyText(text: string): number | null {
  const compact = text.trim().replace(/[\s€$£]/g, '');
  if (compact === '') return null;
  if (!/^[\d.,]+$/.test(compact)) return Number.NaN;
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  let normal = compact;
  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? ',' : '.';
    normal = compact
      .split(decimal === ',' ? '.' : ',')
      .join('')
      .replace(decimal, '.');
  } else if (lastComma !== -1) {
    normal = compact.replace(',', '.');
  }
  const value = Number(normal);
  return Number.isFinite(value) ? Math.round(Number((value * 100).toPrecision(15))) : Number.NaN;
}

/** A typed percentage (VAT, target margin) as basis points; null for blank or unreadable. */
export function parsePercentBps(text: string): number | null {
  const value = parseDecimal(text);
  return value === null ? null : Math.round(Number((value * 100).toPrecision(15)));
}
