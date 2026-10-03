import { recipeInputWeightGrams } from '@/lib/calculations/recipeCost';
import { convertQuantity, effectiveAnchors, type UomAnchors } from '@/lib/calculations/uom';
import { unitLabel, type Dimension, type Unit } from '@/lib/units';
import {
  displayNumberToGrams,
  formatWeightForUnit,
  type WeightDisplayUnit,
} from '@/lib/format/weight';

/**
 * Pure model behind the recipe editor (create + edit share it). Canonical
 * quantities are ALWAYS what the draft holds — grams for weight, ml / pieces for the
 * other dimensions — and the shared g/kg switch only changes what is DISPLAYED and
 * how a typed number is read. Switching the unit therefore never touches a stored
 * quantity, cost or proportion, however many times it is flipped.
 */

/** Ingredient section as stored (sections are preserved, not edited, by the editor). */
export type DraftSection = { ref: string; id?: string; title: string };

export type DraftLine =
  | {
      key: string;
      kind: 'ingredient';
      id?: string;
      ingredientId: string;
      name: string;
      unitLabel: string;
      dimension: Dimension;
      /** Canonical amount: grams, ml or pieces depending on `dimension`. */
      quantity: number;
      /** What the chef typed in another unit (cup, oz, l…). Both set, or both null. */
      enteredQuantity: number | null;
      enteredUnit: Unit | null;
      prepActionId: string | null;
      /** Display-only prep name resolved server-side. */
      prepName?: string | null;
      note: string;
      sectionRef: string | null;
    }
  | {
      key: string;
      kind: 'component';
      id?: string;
      componentRecipeId: string;
      name: string;
      /** Grams of the sub-recipe's finished output. */
      quantityGrams: number;
      note: string;
      sectionRef: string | null;
    };

export type IngredientLine = Extract<DraftLine, { kind: 'ingredient' }>;

/** A structured method section already stored on the recipe (kept, not edited, by the editor). */
export type DraftMethodSection = { ref: string; id?: string; title: string };

export type DraftStepMedia = { mediaId: string; url: string | null };

/** A numbered step saved by an earlier editor — kept, editable, never merged into the notes. */
export type DraftStep = {
  key: string;
  id?: string;
  instruction: string;
  sectionRef: string | null;
  /** Attached READY media in display order. */
  media: DraftStepMedia[];
};

export type PickerOption = { id: string; name: string; dimension?: Dimension };

/** Per-ingredient conversion context (equivalency anchors + prep actions). */
export type LineUom = {
  anchors: UomAnchors | null;
  prepActions: { id: string; name: string; anchors: UomAnchors }[];
};

/** recipe_ingredients.quantity / recipe_components.quantity_grams are numeric(10,2). */
export const CANONICAL_QUANTITY_MAX = 99_999_999.99;

/**
 * Rounds to the stored 2 decimals the way the numeric column would ("2,155" → 2.16):
 * float noise is trimmed first, so 2.155 × 100 = 215.49999999999997 still rounds up.
 */
export function roundToStored(value: number): number {
  return Math.round(Number((value * 100).toPrecision(15))) / 100;
}

/** Short label for a canonical dimension — weight lines use the shared g/kg switch instead. */
export const DIMENSION_LABEL: Record<Dimension, string> = { weight: 'g', volume: 'ml', count: 'pcs' };

/**
 * A typed amount → number ≥ 0, accepting a decimal comma or point ("0,5", "0.5",
 * ".5", "12"). Null for anything else (blank, negative, letters, two separators).
 */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Plain number → short text without float noise or trailing zeros (up to `decimals`). */
export function formatAmount(value: number, decimals = 4): string {
  if (!Number.isFinite(value)) return '';
  let text = value.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

/**
 * How a line's quantity is shown and typed:
 * - `weight`: canonical grams shown in the shared g/kg unit (ingredients by weight,
 *   sub-recipes, and lines typed as plain g/kg — those are just grams);
 * - `entered`: the chef typed another unit (cup, oz, l, tbsp…) — kept as typed, with
 *   its own compact label, and converted through the ingredient's equivalency;
 * - `canonical`: ml or pieces — never reinterpreted as grams.
 */
export type QuantityMode =
  | { kind: 'weight' }
  | { kind: 'entered'; unit: Unit; label: string }
  | { kind: 'canonical'; label: string };

function isPlainWeightUnit(unit: Unit | null): boolean {
  return unit === 'g' || unit === 'kg';
}

export function quantityMode(line: DraftLine): QuantityMode {
  if (line.kind === 'component') return { kind: 'weight' };
  if (line.enteredUnit !== null && line.enteredQuantity !== null && !isPlainWeightUnit(line.enteredUnit)) {
    return { kind: 'entered', unit: line.enteredUnit, label: unitLabel(line.enteredUnit) || DIMENSION_LABEL.count };
  }
  if (line.dimension === 'weight') return { kind: 'weight' };
  return { kind: 'canonical', label: DIMENSION_LABEL[line.dimension] };
}

/** True when the shared g/kg switch applies to this line. */
export function followsDisplayUnit(line: DraftLine): boolean {
  return quantityMode(line).kind === 'weight';
}

export function canonicalQuantity(line: DraftLine): number {
  return line.kind === 'ingredient' ? line.quantity : line.quantityGrams;
}

/** The number to show in a line's quantity field (no unit). */
export function lineQuantityText(line: DraftLine, displayUnit: WeightDisplayUnit): string {
  const mode = quantityMode(line);
  if (mode.kind === 'weight') return formatWeightForUnit(canonicalQuantity(line), displayUnit);
  if (mode.kind === 'entered') return formatAmount((line as IngredientLine).enteredQuantity ?? 0);
  return formatAmount(canonicalQuantity(line), 2);
}

/** The compact unit label beside a line's quantity field. */
export function lineUnitLabel(line: DraftLine, displayUnit: WeightDisplayUnit): string {
  const mode = quantityMode(line);
  return mode.kind === 'weight' ? displayUnit : mode.label;
}

export function anchorsFor(line: IngredientLine, uom: LineUom | undefined): UomAnchors | null {
  if (!uom) return null;
  const prep = uom.prepActions.find((p) => p.id === line.prepActionId);
  return effectiveAnchors(uom.anchors, prep?.anchors ?? null);
}

/**
 * Applies a typed amount (already parsed, in the line's DISPLAYED unit) to the line.
 * Returns null when the amount can't be stored (beyond the column's range). A weight
 * line typed in kg is stored as grams, rounded once to the column's 2 decimals; a
 * plain g/kg entered pair is dropped (the grams say the same thing).
 */
export function applyLineAmount(
  line: DraftLine,
  amount: number,
  displayUnit: WeightDisplayUnit,
  uom?: LineUom,
): DraftLine | null {
  const mode = quantityMode(line);
  if (mode.kind === 'weight') {
    const grams = roundToStored(displayNumberToGrams(amount, displayUnit));
    if (grams > CANONICAL_QUANTITY_MAX) return null;
    return line.kind === 'component'
      ? { ...line, quantityGrams: grams }
      : { ...line, quantity: grams, enteredQuantity: null, enteredUnit: null };
  }
  const ingredient = line as IngredientLine;
  if (mode.kind === 'entered') {
    const converted = convertQuantity(amount, mode.unit, ingredient.dimension, anchorsFor(ingredient, uom));
    const canonical = converted.ok ? roundToStored(converted.canonical) : ingredient.quantity;
    if (canonical > CANONICAL_QUANTITY_MAX) return null;
    return { ...ingredient, enteredQuantity: amount, quantity: canonical };
  }
  const canonical = roundToStored(amount);
  if (canonical > CANONICAL_QUANTITY_MAX) return null;
  return { ...ingredient, quantity: canonical };
}

type AddResult = { lines: DraftLine[]; focusKey: string; added: boolean };

const newKey = () => `new-${crypto.randomUUID()}`;

/**
 * Adds an ingredient row — or, when that ingredient is already in the recipe, returns
 * the existing row to focus instead, so a repeated pick never creates a duplicate.
 */
export function addIngredientLine(lines: DraftLine[], option: PickerOption, makeKey = newKey): AddResult {
  const existing = lines.find((l) => l.kind === 'ingredient' && l.ingredientId === option.id);
  if (existing) return { lines, focusKey: existing.key, added: false };
  const dimension = option.dimension ?? 'weight';
  const key = makeKey();
  return {
    added: true,
    focusKey: key,
    lines: [
      ...lines,
      {
        key,
        kind: 'ingredient',
        ingredientId: option.id,
        name: option.name,
        unitLabel: DIMENSION_LABEL[dimension],
        dimension,
        quantity: 0,
        enteredQuantity: null,
        enteredUnit: null,
        prepActionId: null,
        note: '',
        sectionRef: null,
      },
    ],
  };
}

/** Adds a sub-recipe row (one per sub-recipe — the DB keeps a single line per pair). */
export function addComponentLine(lines: DraftLine[], option: PickerOption, makeKey = newKey): AddResult {
  const existing = lines.find((l) => l.kind === 'component' && l.componentRecipeId === option.id);
  if (existing) return { lines, focusKey: existing.key, added: false };
  const key = makeKey();
  return {
    added: true,
    focusKey: key,
    lines: [
      ...lines,
      { key, kind: 'component', componentRecipeId: option.id, name: option.name, quantityGrams: 0, note: '', sectionRef: null },
    ],
  };
}

/** Moves one row; out-of-range moves return the list unchanged. Order = saved order. */
export function moveLine(lines: DraftLine[], from: number, to: number): DraftLine[] {
  if (from === to || from < 0 || to < 0 || from >= lines.length || to >= lines.length) return lines;
  const next = [...lines];
  const [line] = next.splice(from, 1);
  next.splice(to, 0, line!);
  return next;
}

/**
 * The compact "Total ingredient weight" summary. Honest by construction: an empty
 * recipe says nothing about ml or pieces; a recipe with ml/piece lines names THOSE
 * lines and never presents the weighed subtotal as the whole batch.
 */
export type WeightSummary =
  | { state: 'empty' }
  | { state: 'complete'; totalGrams: number; missingQuantity: string[] }
  | { state: 'partial'; weighedGrams: number; unweighed: string[]; missingQuantity: string[] };

export function weightSummary(lines: DraftLine[]): WeightSummary {
  if (lines.length === 0) return { state: 'empty' };
  let grams = 0;
  const unweighed: string[] = [];
  const missingQuantity: string[] = [];
  for (const line of lines) {
    const quantity = canonicalQuantity(line);
    if (!(quantity > 0)) missingQuantity.push(line.name);
    if (line.kind === 'ingredient' && line.dimension !== 'weight') {
      unweighed.push(line.name);
      continue;
    }
    grams += Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
  }
  const total = roundToStored(grams);
  return unweighed.length > 0
    ? { state: 'partial', weighedGrams: total, unweighed, missingQuantity }
    : { state: 'complete', totalGrams: total, missingQuantity };
}

/** Ingredient input weight in grams for the yield calculation (null = can't be added up). */
export function draftInputWeightGrams(lines: DraftLine[]): number | null {
  return recipeInputWeightGrams(
    lines.map((l) => (l.kind === 'ingredient' ? { dimension: l.dimension, quantity: l.quantity } : { dimension: 'weight' as const, quantity: l.quantityGrams })),
    [],
  );
}

// ── Kitchen presets ───────────────────────────────────────────────────────────

export type PresetRow = { key: string; id?: string; name: string; weightText: string };

export type PresetProblem = 'nameRequired' | 'weightRequired' | 'duplicate';

export type PresetValidation =
  | { ok: true; presets: { id?: string; name: string; targetWeightGrams: number }[] }
  | { ok: false; key: string; problem: PresetProblem };

/** recipe_presets.target_weight_grams is numeric(10,2), strictly positive. */
const PRESET_WEIGHT_MAX = 99_999_999.99;

/**
 * Presets are optional: a row left completely blank is ignored. A half-filled row is
 * pointed out (never silently dropped), and names must be unique per recipe
 * (case-insensitive, like the database). Weights are grams, decimals allowed.
 */
export function validatePresetRows(rows: PresetRow[]): PresetValidation {
  const presets: { id?: string; name: string; targetWeightGrams: number }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const weightText = row.weightText.trim();
    if (name === '' && weightText === '') continue;
    if (name === '') return { ok: false, key: row.key, problem: 'nameRequired' };
    const weight = parseAmount(weightText);
    const grams = weight === null ? null : Math.round(weight * 100) / 100;
    if (grams === null || !(grams > 0) || grams > PRESET_WEIGHT_MAX) {
      return { ok: false, key: row.key, problem: 'weightRequired' };
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) return { ok: false, key: row.key, problem: 'duplicate' };
    seen.add(lower);
    presets.push({ ...(row.id ? { id: row.id } : {}), name, targetWeightGrams: grams });
  }
  return { ok: true, presets };
}

// ── Save payload ──────────────────────────────────────────────────────────────

/** The draft lines as the server's workspace line contract expects them. */
export function linesForSave(lines: DraftLine[]) {
  return lines.map((l) =>
    l.kind === 'ingredient'
      ? {
          kind: 'ingredient' as const,
          ...(l.id ? { id: l.id } : {}),
          ingredientId: l.ingredientId,
          quantity: l.quantity,
          prepActionId: l.prepActionId,
          enteredQuantity: l.enteredQuantity,
          enteredUnit: l.enteredUnit,
          note: l.note.trim() === '' ? null : l.note.trim(),
          sectionRef: l.sectionRef,
        }
      : {
          kind: 'component' as const,
          ...(l.id ? { id: l.id } : {}),
          componentRecipeId: l.componentRecipeId,
          quantityGrams: l.quantityGrams,
          note: l.note.trim() === '' ? null : l.note.trim(),
          sectionRef: l.sectionRef,
        },
  );
}

/** Sub-recipe rows need a weight (> 0) before they can be saved; returns the first one missing it. */
export function firstComponentWithoutWeight(lines: DraftLine[]): DraftLine | null {
  return lines.find((l) => l.kind === 'component' && !(l.quantityGrams > 0)) ?? null;
}
