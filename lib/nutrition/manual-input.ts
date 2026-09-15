import type { NutrientKey } from '@/lib/calculations/nutrition';
import { NUTRIENT_MAX } from '@/lib/validation/ingredient-nutrition';

/**
 * How a typed manual nutrient value is interpreted before autosave:
 *  - `empty`   — nothing typed (unknown). NEVER sent: a field that is empty while
 *                typing is not a deletion; clearing is a separate explicit action.
 *  - `invalid` — not a plain non-negative number within the nutrient's bound.
 *                NEVER sent; the field is flagged instead.
 *  - `value`   — a valid number; `0` is a deliberate zero, distinct from unknown.
 * Accepts digits with one `.` or `,` decimal separator (kitchen keyboards).
 */
export type ParsedNutrientInput =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'value'; value: number };

export function parseNutrientInput(key: NutrientKey, text: string): ParsedNutrientInput {
  const raw = text.trim().replace(',', '.');
  if (raw === '') return { kind: 'empty' };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(raw)) return { kind: 'invalid' };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > NUTRIENT_MAX[key]) {
    return { kind: 'invalid' };
  }
  return { kind: 'value', value };
}
