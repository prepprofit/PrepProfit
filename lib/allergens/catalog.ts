/**
 * Allergen catalog — the single source of truth for the fixed list of allergens
 * and the `presence` levels. Pure data (no DB / no i18n import) so both the server
 * data layer and the client UI can use it, mirroring `CATEGORY_SEED`
 * (lib/finance/categories.ts) and `FOLDER_ICONS` (lib/validation/recipe-folders.ts).
 *
 * SCOPE / COMPLIANCE BOUNDARY (Sprint 9): this is an OPERATIONAL kitchen aid. v1
 * makes NO legal compliance claim — the customer-facing legal DECLARATION is gated
 * by an external food-safety/legal sign-off and is out of v1. The labels below are
 * operational; the official Reg (EU) 1169/2011 Annex II wording must be confirmed
 * (cereals/gluten, tree nuts, sulphites especially) before any future claim. No
 * surface ever says "allergen-free" — reviewed-and-empty reads "no allergens
 * recorded" (the i18n layer enforces the wording).
 */

/** The 14 EU FIC allergens (Reg (EU) 1169/2011 Annex II) as stable slugs. */
export type AllergenSlug =
  | 'cereals_gluten'
  | 'crustaceans'
  | 'eggs'
  | 'fish'
  | 'peanuts'
  | 'soybeans'
  | 'milk'
  | 'nuts'
  | 'celery'
  | 'mustard'
  | 'sesame'
  | 'sulphites'
  | 'lupin'
  | 'molluscs';

export type AllergenCatalogEntry = {
  slug: AllergenSlug;
  /** Fallback operational label; the UI shows `allergens.labels.<slug>` via i18n. */
  label: string;
};

/**
 * Order here is the canonical catalog order — every rollup result, UI chip list,
 * and document column is sorted by a slug's index in this array so output is
 * deterministic (§11.12). Append-only: never reorder existing entries.
 */
export const ALLERGEN_CATALOG: readonly AllergenCatalogEntry[] = [
  { slug: 'cereals_gluten', label: 'Cereals containing gluten' },
  { slug: 'crustaceans', label: 'Crustaceans' },
  { slug: 'eggs', label: 'Eggs' },
  { slug: 'fish', label: 'Fish' },
  { slug: 'peanuts', label: 'Peanuts' },
  { slug: 'soybeans', label: 'Soybeans' },
  { slug: 'milk', label: 'Milk' },
  { slug: 'nuts', label: 'Tree nuts' },
  { slug: 'celery', label: 'Celery' },
  { slug: 'mustard', label: 'Mustard' },
  { slug: 'sesame', label: 'Sesame' },
  { slug: 'sulphites', label: 'Sulphur dioxide and sulphites' },
  { slug: 'lupin', label: 'Lupin' },
  { slug: 'molluscs', label: 'Molluscs' },
] as const;

/** All allergen slugs, in catalog order (for the Zod enum + DB CHECK whitelist). */
export const ALLERGEN_SLUGS = ALLERGEN_CATALOG.map((a) => a.slug) as [
  AllergenSlug,
  ...AllergenSlug[],
];

/** Zero-based catalog index of a slug, for deterministic sorting. */
export const ALLERGEN_ORDER: Record<AllergenSlug, number> = Object.fromEntries(
  ALLERGEN_CATALOG.map((a, i) => [a.slug, i]),
) as Record<AllergenSlug, number>;

/**
 * `presence` models CERTAINTY OF PRESENCE, never clinical severity (so the field
 * is `presence`, not `severity`): `contains` = a deliberate ingredient; `may_contain`
 * = cross-contamination / traces. PRESENCE_ORDER ranks them so `max()` can pick the
 * stronger statement (`contains` > `may_contain`).
 */
export type Presence = 'may_contain' | 'contains';

/** Ranking of presence levels — higher wins in a `max`. */
export const PRESENCE_ORDER: Record<Presence, number> = {
  may_contain: 0,
  contains: 1,
};

/** All presence values, weakest-first (for the Zod enum + DB CHECK whitelist). */
export const PRESENCE_VALUES = ['may_contain', 'contains'] as const;

/** Type guard: is `value` one of the 14 catalog slugs? */
export function isAllergenSlug(value: string): value is AllergenSlug {
  return value in ALLERGEN_ORDER;
}

/** Type guard: is `value` a valid presence level? */
export function isPresence(value: string): value is Presence {
  return value === 'may_contain' || value === 'contains';
}
