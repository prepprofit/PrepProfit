import type { RecipePrepCardLabels } from './types';

/**
 * Localized label set for an operational prep card, from a next-intl translator
 * scoped to the `recipePrepCardDocument` namespace. Shared by the PDF renderer and
 * the HTML print page so both render identical wording. Money-free by design — there
 * is intentionally no cost/price/margin label here.
 */
export function buildRecipePrepCardLabels(
  t: (key: string, values?: Record<string, string>) => string,
): RecipePrepCardLabels {
  return {
    title: t('title'),
    yield: t('yield'),
    portions: t('portions'),
    usableYield: t('usableYield'),
    scaledTo: ({ portions, factor }) => t('scaledTo', { portions, factor }),
    ingredient: t('ingredient'),
    quantity: t('quantity'),
    notes: t('notes'),
    units: {
      weight: t('units.weight'),
      volume: t('units.volume'),
      count: t('units.count'),
    },
  };
}
