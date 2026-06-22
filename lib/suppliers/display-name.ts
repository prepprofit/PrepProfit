import { dimensionOf, type Dimension, type Unit } from '@/lib/units';

/**
 * Supplier display-name selection (Sprint 7) — the deterministic F6 §3 rule for
 * picking ONE display name when several raw spellings collapse to the same dedup
 * key (`'ACME'`, `'Acme'`, `'acme'` → one supplier). The backfill calls this so a
 * re-run always picks the same name (idempotent): the MOST FREQUENT raw spelling
 * wins; ties break by lexicographic (case-sensitive) order, smallest first.
 *
 * Pure — no I/O. Empty input is a caller error (a group always has ≥1 name); it
 * returns `''` defensively rather than throwing, but callers reject empty keys
 * upstream (lib/suppliers/normalize.ts).
 */
export function pickSupplierDisplayName(names: readonly string[]): string {
  if (names.length === 0) return '';

  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  let best = '';
  let bestCount = -1;
  for (const [name, count] of counts) {
    if (count > bestCount || (count === bestCount && name < best)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Whether a pack `unit` is compatible with an ingredient's `dimension` (§12.7) —
 * e.g. `kg` belongs to a `weight` ingredient, not a `volume` one. The pack price
 * derives a per-unit cost in the ingredient's canonical unit, so a cross-dimension
 * unit is meaningless. The caller has already validated `unit` is a known `Unit`
 * (Zod enum), so this is a pure dimension comparison.
 */
export function isPackUnitCompatible(unit: Unit, dimension: Dimension): boolean {
  return dimensionOf(unit) === dimension;
}
