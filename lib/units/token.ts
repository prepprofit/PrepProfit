import type { Unit } from './index';

/**
 * Raw unit-TOKEN resolution — the single source of truth for turning a free-text
 * unit token ("g", "kilograms", "cups", "") into a canonical {@link Unit}. Shared
 * by the spreadsheet recipe parser (lib/import/parse.ts) and the AI photo-extraction
 * mapper (lib/ai/map-extraction.ts) so both honour the SAME alias set and the SAME
 * rule: blank ⇒ count, a known token/alias ⇒ its unit, anything else ⇒ a row issue
 * (`INVALID_UNIT`) — never a silent guess (CLAUDE.md AI/import rules).
 */

/** The canonical unit tokens accepted verbatim. */
const UNIT_SET = new Set<Unit>(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'floz', 'cup', 'count']);

/** Friendly aliases (lowercased, whitespace-stripped) mapped to a canonical unit. */
const UNIT_ALIASES: Record<string, Unit> = {
  gram: 'g', grams: 'g', g: 'g',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  millilitre: 'ml', milliliter: 'ml', millilitres: 'ml', milliliters: 'ml',
  litre: 'l', liter: 'l', litres: 'l', liters: 'l',
  fluidounce: 'floz', fluidounces: 'floz',
  cups: 'cup',
  piece: 'count', pieces: 'count', pc: 'count', pcs: 'count', unit: 'count', units: 'count', each: 'count',
};

export type ParseUnitTokenResult = { unit: Unit } | { error: 'INVALID_UNIT' };

/** Resolve a unit token to a `Unit`; blank ⇒ count; unknown ⇒ `INVALID_UNIT`. */
export function parseUnitToken(raw: string): ParseUnitTokenResult {
  const v = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (v === '') return { unit: 'count' };
  if (UNIT_SET.has(v as Unit)) return { unit: v as Unit };
  const alias = UNIT_ALIASES[v];
  if (alias) return { unit: alias };
  return { error: 'INVALID_UNIT' };
}
