/**
 * Unit conversion — the UI edge for physical quantities.
 *
 * Storage is ALWAYS canonical: grams (weight), millilitres (volume), and a plain
 * count (count). These helpers convert to/from the units a chef actually sees,
 * driven by the organization's `measurement_system`. Nothing here touches money.
 *
 * Imperial volume uses US customary fluid ounces and cups
 * (1 fl oz = 29.5735295625 ml, 1 cup = 236.5882365 ml).
 */

export type Dimension = 'weight' | 'volume' | 'count';
export type MeasurementSystem = 'metric' | 'imperial';

export type WeightUnit = 'g' | 'kg' | 'oz' | 'lb';
/**
 * `tsp`/`tbsp` are true measurable cooking volumes (US customary: 1 tsp =
 * 4.92892159375 ml, 1 tbsp = 14.78676478125 ml). They are accepted as ENTRY/parse
 * units — chefs write them on recipe cards — and canonicalize to ml like any other
 * volume. They are deliberately NOT offered by `displayUnitsFor`/`pickDisplayUnit`
 * (storage stays ml/l), so dropdowns and auto-display are unchanged. Package
 * DESCRIPTORS (pkt, block, can…) are NOT units and never enter this union.
 */
export type VolumeUnit = 'ml' | 'l' | 'floz' | 'cup' | 'tsp' | 'tbsp';
export type CountUnit = 'count';
export type Unit = WeightUnit | VolumeUnit | CountUnit;

/** Multiply a value in `Unit` by this to get the canonical amount (g / ml / count). */
const UNIT_TO_CANONICAL: Record<Unit, number> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
  ml: 1,
  l: 1000,
  floz: 29.5735295625,
  cup: 236.5882365,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  count: 1,
};

const UNIT_DIMENSION: Record<Unit, Dimension> = {
  g: 'weight',
  kg: 'weight',
  oz: 'weight',
  lb: 'weight',
  ml: 'volume',
  l: 'volume',
  floz: 'volume',
  cup: 'volume',
  tsp: 'volume',
  tbsp: 'volume',
  count: 'count',
};

/** Short label shown next to a quantity. Count has no unit (bare number). */
const UNIT_LABEL: Record<Unit, string> = {
  g: 'g',
  kg: 'kg',
  oz: 'oz',
  lb: 'lb',
  ml: 'ml',
  l: 'l',
  floz: 'fl oz',
  cup: 'cup',
  tsp: 'tsp',
  tbsp: 'tbsp',
  count: '',
};

/** Decimal places used when displaying each unit. */
const UNIT_DECIMALS: Record<Unit, number> = {
  g: 0,
  kg: 3,
  oz: 1,
  lb: 2,
  ml: 0,
  l: 3,
  floz: 1,
  cup: 2,
  tsp: 2,
  tbsp: 2,
  count: 0,
};

export function dimensionOf(unit: Unit): Dimension {
  return UNIT_DIMENSION[unit];
}

/** Short label for a unit (e.g. `'kg'`, `'fl oz'`). Count has no label. */
export function unitLabel(unit: Unit): string {
  return UNIT_LABEL[unit];
}

/** Value in `unit` → canonical amount (g / ml / count). */
export function toCanonical(value: number, unit: Unit): number {
  return value * UNIT_TO_CANONICAL[unit];
}

/** Canonical amount (g / ml / count) → value expressed in `unit`. */
export function fromCanonical(canonical: number, unit: Unit): number {
  return canonical / UNIT_TO_CANONICAL[unit];
}

/** The units offered for a dimension under a measurement system (smallest first). */
export function displayUnitsFor(
  dimension: Dimension,
  system: MeasurementSystem,
): Unit[] {
  if (dimension === 'count') return ['count'];
  if (dimension === 'weight') {
    return system === 'imperial' ? ['oz', 'lb'] : ['g', 'kg'];
  }
  return system === 'imperial' ? ['floz', 'cup'] : ['ml', 'l'];
}

/**
 * Pick the friendliest display unit for a canonical amount: grams below a
 * kilogram, kilograms at or above; the imperial and volume equivalents likewise.
 */
export function pickDisplayUnit(
  canonical: number,
  dimension: Dimension,
  system: MeasurementSystem,
): Unit {
  const magnitude = Math.abs(canonical);
  if (dimension === 'count') return 'count';
  if (dimension === 'weight') {
    return system === 'imperial'
      ? magnitude >= UNIT_TO_CANONICAL.lb
        ? 'lb'
        : 'oz'
      : magnitude >= UNIT_TO_CANONICAL.kg
        ? 'kg'
        : 'g';
  }
  return system === 'imperial'
    ? magnitude >= UNIT_TO_CANONICAL.cup
      ? 'cup'
      : 'floz'
    : magnitude >= UNIT_TO_CANONICAL.l
      ? 'l'
      : 'ml';
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Format a value already expressed in `unit` (e.g. `2.5` + `'kg'` → `"2.5 kg"`). */
export function formatInUnit(value: number, unit: Unit): string {
  const num = String(roundTo(value, UNIT_DECIMALS[unit]));
  const label = UNIT_LABEL[unit];
  return label ? `${num} ${label}` : num;
}

/**
 * Human string for a canonical amount, picking the unit by magnitude and
 * measurement system. `formatQuantity(1500, 'weight', 'metric')` → `"1.5 kg"`.
 */
export function formatQuantity(
  canonical: number,
  dimension: Dimension,
  system: MeasurementSystem,
): string {
  const unit = pickDisplayUnit(canonical, dimension, system);
  return formatInUnit(fromCanonical(canonical, unit), unit);
}
