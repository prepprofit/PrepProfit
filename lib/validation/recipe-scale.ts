import { z } from 'zod';

/**
 * Server-side validation for the recipe-scaling query param (Recipe scaling MVP).
 *
 * Every export surface (prep-card + cost-sheet PDF/print) takes scale from ONE
 * readable, bookmarkable query shape: `?portions=<positive decimal>`. Both scale
 * modes funnel through it — target-portions directly, and anchor mode by passing the
 * equivalent (possibly fractional) portions, so the exact factor survives the URL.
 *
 * RULE: all client input is Zod-validated on the server. A malformed `portions`
 * yields a 400 (API) / unscaled fallback (print page) rather than silently mis-scaling.
 * A conservative cap (`1_000_000`) and a ≤ 4-decimal limit keep URLs stable and reject
 * accidental high-precision or absurd values; `0`, negatives, `NaN`, `Infinity`,
 * blanks, and arrays are all rejected.
 */

/** Hard upper bound on the requested portions (well below any sane batch). */
export const RECIPE_SCALE_PORTIONS_MAX = 1_000_000;

/** A positive decimal string with up to 4 decimal places, within the cap. */
export const scalePortionsSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,4})?$/)
  .transform((s) => Number(s))
  .refine(
    (n) => Number.isFinite(n) && n > 0 && n <= RECIPE_SCALE_PORTIONS_MAX,
    { message: 'portions must be a positive number within range' },
  );

export type ParsedScale =
  | { ok: true; portions: number | null }
  | { ok: false };

/**
 * Parse a raw `portions` query value. A MISSING value (`undefined`/`null`) is
 * "unscaled" → `{ ok: true, portions: null }`. A present-but-invalid value (blank,
 * non-numeric, ≤ 0, over-precision, over-cap, or an array) → `{ ok: false }`.
 */
export function parseScaleParam(
  raw: string | string[] | null | undefined,
): ParsedScale {
  if (raw === null || raw === undefined) return { ok: true, portions: null };
  if (Array.isArray(raw)) return { ok: false };
  const parsed = scalePortionsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false };
  return { ok: true, portions: parsed.data };
}
