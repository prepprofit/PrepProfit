import { z } from 'zod';

/**
 * Server-side validation for the Kitchen Scale print/PDF query contract
 * (Kitchen Scale redesign). Unlike the older `?portions=` contract in
 * `lib/validation/recipe-scale.ts` (still used, unchanged, by the manager cost
 * sheet at `/recipes/[id]/card/*`), the redesigned prep-card routes take the
 * exact multiplier the on-screen calculator already derived:
 *
 *   `?factor=<positive decimal>`
 *
 * The client (any of the three calculation methods — target weight, ingredient
 * amount, or combined presets) always derives ONE `factor` via
 * `lib/calculations/recipeScale.ts`'s `deriveScale`, then serializes it with
 * `formatFactorParam` and passes the SAME string to both the print page and the
 * PDF route. The server re-applies that exact factor to the recipe's ORIGINAL
 * (unscaled) line quantities (`{ kind: 'factor', factor }` in `deriveScale`), so
 * printed/downloaded quantities always match the calculator on screen — never a
 * value reconstructed from a rounded intermediate (e.g. a portions count).
 *
 * A handful of additional, OPTIONAL params carry only the human-readable
 * "calculation basis" caption ("Target weight: 3.5 kg", "45 individual portions +
 * 4 × 18 cm cake"). They are parsed leniently and never block scaling: a
 * missing/malformed basis param just falls back to a generic caption, because the
 * printed QUANTITIES are driven exclusively by `factor`.
 */

/** Generous enough for any real batch; overflow is still caught per-line by
 *  `deriveScale`'s `RECIPE_SCALE_QUANTITY_MAX` guard. */
export const PREP_CARD_FACTOR_MAX = 1_000_000;

/** A positive decimal string with up to 8 decimal places, within the cap. */
export const prepCardFactorSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,8})?$/)
  .transform((s) => Number(s))
  .refine(
    (n) => Number.isFinite(n) && n > 0 && n <= PREP_CARD_FACTOR_MAX,
    { message: 'factor must be a positive number within range' },
  );

export type ParsedPrepCardFactor = { ok: true; factor: number | null } | { ok: false };

/**
 * Parse the `?factor=` query value. Missing (`undefined`/`null`) is "unscaled"
 * (factor 1, the saved recipe as-is). A present-but-invalid value (blank,
 * non-numeric, ≤ 0, over-precision, over-cap, or an array) is `{ ok: false }` —
 * the print page falls back to unscaled and the PDF route returns 400, exactly
 * like the older `?portions=` contract.
 */
export function parsePrepCardFactorParam(
  raw: string | string[] | null | undefined,
): ParsedPrepCardFactor {
  if (raw === null || raw === undefined) return { ok: true, factor: null };
  if (Array.isArray(raw)) return { ok: false };
  const parsed = prepCardFactorSchema.safeParse(raw);
  if (!parsed.success) return { ok: false };
  return { ok: true, factor: parsed.data };
}

/** Serialize a factor for the `?factor=` query — the single source of truth
 *  both the print link and the download link build from, so they always agree. */
export function formatFactorParam(factor: number): string {
  return String(Math.round(factor * 1e8) / 1e8);
}

/** Bounds for the optional caption-only canonical-amount params (`grams`/`target`/`extra`). */
const CAPTION_AMOUNT_MAX = 999_999_999;
const captionAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,4})?$/)
  .transform((s) => Number(s))
  .refine((n) => Number.isFinite(n) && n > 0 && n <= CAPTION_AMOUNT_MAX);

/** One preset's quantity in a `?sel=id:qty,id:qty` combined-presets caption. */
export type PrepCardPresetSelection = { presetId: string; quantity: number };

/** The human-readable "calculation basis" the print header caption describes. */
export type PrepCardBasisParam =
  | { kind: 'weight'; grams: number }
  | { kind: 'line'; lineId: string; target: number }
  | { kind: 'preset'; selections: PrepCardPresetSelection[]; extraGrams: number };

/**
 * Parse the optional basis caption params from a URL's search params. Returns
 * `null` when absent or malformed in any way — callers fall back to a generic
 * "Scaled ×factor" caption in that case. Never throws, never affects the
 * (separately validated) `factor` that actually drives the printed quantities.
 */
export function parsePrepCardBasisParam(
  searchParams: URLSearchParams,
): PrepCardBasisParam | null {
  const basis = searchParams.get('basis');
  if (basis === 'weight') {
    const grams = captionAmountSchema.safeParse(searchParams.get('grams'));
    return grams.success ? { kind: 'weight', grams: grams.data } : null;
  }
  if (basis === 'line') {
    const lineId = searchParams.get('lineId');
    const target = captionAmountSchema.safeParse(searchParams.get('target'));
    if (!lineId || lineId.length > 64 || !target.success) return null;
    return { kind: 'line', lineId, target: target.data };
  }
  if (basis === 'preset') {
    const rawSel = searchParams.get('sel') ?? '';
    const selections: PrepCardPresetSelection[] = [];
    if (rawSel !== '') {
      const parts = rawSel.split(',').slice(0, 50);
      for (const part of parts) {
        const [presetId, rawQty] = part.split(':');
        if (!presetId || presetId.length > 64 || rawQty === undefined) continue;
        const qty = captionAmountSchema.safeParse(rawQty);
        if (qty.success) selections.push({ presetId, quantity: qty.data });
      }
    }
    const rawExtra = searchParams.get('extra');
    const extra = rawExtra != null ? captionAmountSchema.safeParse(rawExtra) : null;
    if (selections.length === 0 && !extra?.success) return null;
    return { kind: 'preset', selections, extraGrams: extra?.success ? extra.data : 0 };
  }
  return null;
}

/** Build the `?sel=` query fragment for a combined-presets caption. */
export function formatPresetSelectionParam(
  selections: readonly PrepCardPresetSelection[],
): string {
  return selections
    .map((s) => `${s.presetId}:${Math.round(s.quantity * 10000) / 10000}`)
    .join(',');
}
