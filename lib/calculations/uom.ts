import { dimensionOf, toCanonical, type Dimension, type Unit } from '@/lib/units';

/**
 * Cross-dimension UoM conversion (Recipes 2.0, plan §7.2). Pure, no I/O.
 *
 * Same-dimension conversion uses `lib/units` (fixed physical factors).
 * CROSS-dimension conversion (cups of flour → grams) is ingredient-specific
 * physics and requires an equivalency: a set of anchors that all describe the
 * SAME amount of the ingredient (e.g. 141.75 g = 236.59 ml = 1 each).
 *
 *   weight → volume = inputGrams / anchorWeightGrams * anchorVolumeMl
 *
 * The result is discriminated — a missing anchor is an honest
 * `MISSING_EQUIVALENCY`, NEVER a silent zero (1 ml is not 1 g).
 */

export type UomAnchors = {
  weightGrams: number | null;
  volumeMl: number | null;
  eachCount: number | null;
};

/** Canonical storage unit of each dimension. */
export const CANONICAL_UNIT = {
  weight: 'g',
  volume: 'ml',
  count: 'count',
} as const satisfies Record<Dimension, string>;

export type CanonicalUnit = (typeof CANONICAL_UNIT)[Dimension];

export type UomConversionResult =
  | { ok: true; canonical: number; unit: CanonicalUnit }
  | { ok: false; reason: 'MISSING_EQUIVALENCY' | 'INVALID_INPUT' };

const ANCHOR_KEY: Record<Dimension, keyof UomAnchors> = {
  weight: 'weightGrams',
  volume: 'volumeMl',
  count: 'eachCount',
};

/** An anchor only counts when it is a finite, strictly positive number. */
function anchorFor(anchors: UomAnchors | null, dimension: Dimension): number | null {
  const value = anchors?.[ANCHOR_KEY[dimension]];
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A usable equivalency needs at least TWO positive anchors — a single anchor
 * describes nothing relative to another dimension.
 */
export function hasUsableAnchorPair(anchors: UomAnchors | null): boolean {
  const count = (['weight', 'volume', 'count'] as const).filter(
    (d) => anchorFor(anchors, d) !== null,
  ).length;
  return count >= 2;
}

/**
 * Anchors in effect for a line: a prep action's anchors REPLACE the
 * ingredient's base equivalency entirely when the prep carries any positive
 * anchor ("onion, diced" packs differently than "onion, whole" — mixing a
 * whole-onion gram anchor with a diced-onion ml anchor would be physically
 * wrong). A prep with no anchors falls back to the base equivalency.
 */
export function effectiveAnchors(
  base: UomAnchors | null,
  prep: UomAnchors | null,
): UomAnchors | null {
  const prepHasAny = (['weight', 'volume', 'count'] as const).some(
    (d) => anchorFor(prep, d) !== null,
  );
  return prepHasAny ? prep : base;
}

/**
 * The anchor dimensions missing for a `from → to` conversion (order: from,
 * to). Empty array = convertible. Powers the actionable UI message ("add a
 * weight anchor"); same-dimension conversion never misses anything.
 */
export function missingAnchorDimensions(
  from: Dimension,
  to: Dimension,
  anchors: UomAnchors | null,
): Dimension[] {
  if (from === to) return [];
  return [from, to].filter((d) => anchorFor(anchors, d) === null);
}

export type MissingAnchorLine = {
  ingredientId: string;
  /** The ingredient's canonical dimension (the conversion TARGET). */
  targetDimension: Dimension;
  /** Dimension of the line's entered unit, or null when entered canonically. */
  enteredDimension: Dimension | null;
  baseAnchors: UomAnchors | null;
  prepAnchors: UomAnchors | null;
};

/**
 * Per-ingredient anchor dimensions that its lines cannot convert to the
 * ingredient's dimension (§7.2). Powers the UoM tab's actionable
 * missing-equivalency warning: a line entered in ml/each whose equivalency (or
 * the line's prep override) lacks a required anchor. Same-dimension and
 * canonical-entry lines never contribute. Deterministic order per ingredient.
 */
export function missingAnchorsByIngredient(
  lines: MissingAnchorLine[],
): Map<string, Dimension[]> {
  const sets = new Map<string, Set<Dimension>>();
  for (const line of lines) {
    if (line.enteredDimension === null || line.enteredDimension === line.targetDimension) {
      continue;
    }
    const anchors = effectiveAnchors(line.baseAnchors, line.prepAnchors);
    const missing = missingAnchorDimensions(
      line.enteredDimension,
      line.targetDimension,
      anchors,
    );
    if (missing.length === 0) continue;
    const set = sets.get(line.ingredientId) ?? new Set<Dimension>();
    for (const d of missing) set.add(d);
    sets.set(line.ingredientId, set);
  }
  const result = new Map<string, Dimension[]>();
  const order: Dimension[] = ['weight', 'volume', 'count'];
  for (const [id, set] of sets) {
    result.set(id, order.filter((d) => set.has(d)));
  }
  return result;
}

/**
 * Convert an entered `value` in `unit` to the canonical amount of
 * `targetDimension` (g / ml / count). Zero is a valid input (a draft line may
 * be 0); NaN, Infinity and negatives are `INVALID_INPUT`. Cross-dimension
 * conversion without both anchors is `MISSING_EQUIVALENCY` — never zero.
 */
export function convertQuantity(
  value: number,
  unit: Unit,
  targetDimension: Dimension,
  anchors: UomAnchors | null,
): UomConversionResult {
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, reason: 'INVALID_INPUT' };
  }

  const from = dimensionOf(unit);
  const canonicalIn = toCanonical(value, unit);
  if (from === targetDimension) {
    return { ok: true, canonical: canonicalIn, unit: CANONICAL_UNIT[targetDimension] };
  }

  const fromAnchor = anchorFor(anchors, from);
  const toAnchor = anchorFor(anchors, targetDimension);
  if (fromAnchor === null || toAnchor === null) {
    return { ok: false, reason: 'MISSING_EQUIVALENCY' };
  }

  const canonical = (canonicalIn / fromAnchor) * toAnchor;
  if (!Number.isFinite(canonical)) return { ok: false, reason: 'INVALID_INPUT' };
  return { ok: true, canonical, unit: CANONICAL_UNIT[targetDimension] };
}
