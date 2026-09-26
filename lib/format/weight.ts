/**
 * Presentation-only g/kg conversion for the recipe workspace's per-recipe unit
 * selector. Canonical quantities always stay in grams; these helpers only
 * convert what's DISPLAYED and PARSED, never what's stored, so switching the
 * unit back and forth can never drift the underlying number.
 */
export type WeightDisplayUnit = 'g' | 'kg';

export function gramsToDisplayNumber(grams: number, unit: WeightDisplayUnit): number {
  return unit === 'kg' ? grams / 1000 : grams;
}

export function displayNumberToGrams(value: number, unit: WeightDisplayUnit): number {
  return unit === 'kg' ? value * 1000 : value;
}

/** Trims to a fixed precision then strips trailing zeros, so 1000 g → "1", 2 g → "0.002" (kg). */
export function formatWeightForUnit(grams: number, unit: WeightDisplayUnit): string {
  const value = gramsToDisplayNumber(grams, unit);
  const decimals = unit === 'kg' ? 6 : 2;
  let text = value.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '' || text === '-0' ? '0' : text;
}

export function formatWeightLabel(grams: number, unit: WeightDisplayUnit): string {
  return `${formatWeightForUnit(grams, unit)} ${unit}`;
}

/** Parses a typed number (accepts comma or dot decimals) in the given display unit, returning grams. */
export function parseWeightInput(text: string, unit: WeightDisplayUnit): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return displayNumberToGrams(n, unit);
}
