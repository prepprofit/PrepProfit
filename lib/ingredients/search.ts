import type { DefaultSupplierSummary } from '@/lib/data/ingredient-suppliers';

/**
 * The ingredients list's search box (decision: `docs/*` UX notes for the
 * name-first redesign). It matches the ingredient's own name, its displayed
 * (default) supplier, and — where the viewer's default-supplier link is loaded
 * (manager-only, Sprint 7: suppliers carry pricing, so kitchen never gets this
 * data) — that supplier's purchasing-only product name and code. For example,
 * searching a supplier's own name for a product ("Mantelijauhe") finds the
 * ingredient it's linked to ("Almond flour") without ever renaming it.
 *
 * Only the ingredient's DEFAULT link is ever loaded client-side (one per
 * ingredient), so a query can never match more than one link and produce a
 * duplicate row for the same ingredient.
 */
export type SearchableIngredient = {
  name: string;
  /** The legacy mirrored column — the ingredient's displayed default supplier. */
  supplier: string | null;
};

export function ingredientMatchesQuery(
  row: SearchableIngredient,
  link: DefaultSupplierSummary | null,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const haystacks = [
    row.name,
    row.supplier,
    link?.supplierName ?? null,
    link?.supplierProductName ?? null,
    link?.supplierSku ?? null,
  ];
  return haystacks.some((value) => value != null && value.toLowerCase().includes(q));
}
