import { dimensionOf, toCanonical } from '@/lib/units';
import { parseRecipeUnit } from '@/lib/units/descriptor';
import { canonicalPackageSize } from './photo-draft';

/**
 * Phase 6 — supplier pack integration (improvement plan §6 / §13). When a photo-draft
 * line is a PURCHASE-PACK descriptor with no usable package size of its own (`1 pkt
 * phyllo`, `1 block butter`, `1 bag walnuts`), it stays `needs_review` because a bare
 * "1 pkt" cannot be canonicalized to weight/volume. This pure resolver tries to fill
 * that package size from the ingredient's own org-scoped supplier packs
 * (`ingredient_suppliers.pack_size` / `pack_unit`) — turning a `needs_review` line into
 * a `ready` one WITHOUT the chef typing the pack size.
 *
 * Safety rules from the plan (this module owns the policy; the DB/UI wiring is a later
 * slice):
 *  - It NEVER touches price. Resolving a pack size only canonicalizes the recipe line's
 *    QUANTITY; the ingredient's own price is untouched, so "never auto-price from AI
 *    text alone" holds — a new AI ingredient still defaults to priceCents=0/needsPricing.
 *  - It resolves ONLY purchase-container descriptors (pkt/bag/block/can/…). Portion
 *    descriptors (clove/slice/pinch/leaf/…) are deliberately NOT resolved: a supplier
 *    pack is the WHOLE purchase unit, so applying it to "3 cloves garlic" would cost
 *    1.5 kg instead of ~9 g. Those stay `needs_review` for a human.
 *  - The match must be UNAMBIGUOUS: exactly one distinct usable pack size for the
 *    ingredient. Zero usable packs, or two packs of different physical size, leave the
 *    line unresolved.
 *  - A line that already carries a usable package size is left untouched — the chef's
 *    own entry always wins over an inferred pack.
 *
 * Pure and dependency-free (no DB, no SDK), so it is fully unit-testable from fixtures.
 */

/**
 * Container descriptors that denote a whole PURCHASE PACK — the only descriptors a
 * supplier pack size may be inferred for. A subset of the descriptor vocabulary in
 * `lib/units/descriptor.ts`; portion/piece words (clove, slice, sheet, leaf, stick,
 * pinch, dash, drop, splash, handful, glug, knob, cube, bunch, sprig, stalk, stem,
 * head, bulb, strip) are intentionally excluded.
 */
const PACK_DESCRIPTORS = new Set<string>([
  'pkt', 'packet', 'packets', 'pack', 'packs',
  'bag', 'bags', 'sack', 'sacks',
  'box', 'boxes', 'carton', 'cartons',
  'block', 'blocks', 'bar', 'bars',
  'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'bottle', 'bottles', 'tub', 'tubs',
]);

/** Normalize a descriptor word for membership lookup (mirrors descriptor.ts). */
const normalizeDescriptor = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, '');

/** One candidate purchase pack for an ingredient (from `ingredient_suppliers`). */
export type SupplierPackCandidate = {
  /** Pack size in `packUnit` (e.g. 5 for "5 kg"); the DB `numeric` parsed to a number. */
  packSize: number | null;
  /** The pack's measurement unit token (e.g. "kg"); a descriptor/blank is not usable. */
  packUnit: string | null;
};

/** The line fields the resolver inspects — a subset of `PhotoDraftLine`. */
export type PackResolvableLine = {
  unitToken: string | null;
  packageSizeValue: number | null;
  packageSizeUnitToken: string | null;
};

export type SupplierPackResolution =
  | {
      resolved: true;
      /** The pack size to apply to the line so it canonicalizes (matches the line type). */
      packageSizeValue: number;
      packageSizeUnitToken: string;
    }
  | {
      resolved: false;
      reason:
        // The line's unit is not a descriptor (a true unit needs no pack inference).
        | 'NOT_DESCRIPTOR'
        // A portion descriptor (clove/slice/…) — never inferred from a purchase pack.
        | 'NOT_PACK_DESCRIPTOR'
        // The line already has a usable package size — the chef's entry wins.
        | 'ALREADY_SIZED'
        // The ingredient has no usable supplier pack (none, or all blank/zero/descriptor unit).
        | 'NO_USABLE_PACK'
        // Two or more distinct physical pack sizes — too ambiguous to pick one.
        | 'AMBIGUOUS_PACK';
    };

/**
 * Try to fill a descriptor line's package size from an ingredient's supplier packs.
 * Returns the pack size to apply (resolved) or a stable reason it was left unresolved.
 * The caller (stage endpoint, later slice) applies the result and re-derives the line
 * status via `deriveDraftLineStatus`, so this never decides `ready` on its own.
 */
export function resolveSupplierPack(
  line: PackResolvableLine,
  candidates: readonly SupplierPackCandidate[],
): SupplierPackResolution {
  const unit = parseRecipeUnit(line.unitToken ?? '');
  if (unit.kind !== 'descriptor') return { resolved: false, reason: 'NOT_DESCRIPTOR' };
  if (!PACK_DESCRIPTORS.has(normalizeDescriptor(unit.descriptor))) {
    return { resolved: false, reason: 'NOT_PACK_DESCRIPTOR' };
  }
  // The chef's own pack size always wins — never override a usable entry.
  if (canonicalPackageSize(line.packageSizeValue, line.packageSizeUnitToken)) {
    return { resolved: false, reason: 'ALREADY_SIZED' };
  }

  // Keep only packs that canonicalize (positive size + a real measurable unit), each
  // tagged with its physical magnitude + dimension so duplicates collapse to one.
  const usable = candidates.flatMap((c) => {
    const pack = canonicalPackageSize(c.packSize, c.packUnit);
    if (!pack) return [];
    return [
      {
        packageSizeValue: pack.value,
        packageSizeUnitToken: c.packUnit as string,
        magnitude: toCanonical(pack.value, pack.unit),
        dimension: dimensionOf(pack.unit),
      },
    ];
  });
  const [first] = usable;
  if (!first) return { resolved: false, reason: 'NO_USABLE_PACK' };

  // Distinct physical pack = (canonical magnitude, dimension). Two supplier rows that
  // describe the SAME size in different units (1 kg vs 1000 g) count as one.
  const allSame = usable.every(
    (p) => p.dimension === first.dimension && Math.abs(p.magnitude - first.magnitude) < 1e-6,
  );
  if (!allSame) return { resolved: false, reason: 'AMBIGUOUS_PACK' };

  return {
    resolved: true,
    packageSizeValue: first.packageSizeValue,
    packageSizeUnitToken: first.packageSizeUnitToken,
  };
}
