import { ALLERGEN_SLUGS, type AllergenSlug } from '@/lib/allergens/catalog';
import type { AllergenMatrixLabels } from './types';

/**
 * Build the localized label set for the kitchen allergen matrix from two next-intl
 * translators: `doc` scoped to the `allergenMatrixDocument` namespace (titles,
 * disclaimer, presence markers) and `names` scoped to `allergens.labels` (the 14
 * allergen column labels). Shared by the PDF + XLSX renderers so wording matches.
 */
export function buildAllergenMatrixLabels(
  doc: (key: string) => string,
  names: (slug: string) => string,
): AllergenMatrixLabels {
  const allergenLabels = Object.fromEntries(
    ALLERGEN_SLUGS.map((slug) => [slug, names(slug)]),
  ) as Record<AllergenSlug, string>;

  return {
    title: doc('title'),
    generatedOn: doc('generatedOn'),
    recipe: doc('recipe'),
    disclaimer: doc('disclaimer'),
    noAllergensRecorded: doc('noAllergensRecorded'),
    presence: {
      contains: doc('presence.contains'),
      may_contain: doc('presence.may_contain'),
    },
    unreviewed: doc('unreviewed'),
    allergenLabels,
  };
}
