import type { RecipePrepCardLabels } from './types';

/**
 * Localized label set for the Kitchen Scale prep card, from a next-intl
 * translator scoped to the `recipePrepCardDocument` namespace. Shared by the PDF
 * renderer and the HTML print page so both render identical wording. Money-free
 * by design — there is intentionally no cost/price/margin label here.
 */
export function buildRecipePrepCardLabels(
  t: (key: string, values?: Record<string, string>) => string,
): RecipePrepCardLabels {
  return {
    brand: (businessName) =>
      businessName ? t('brand', { business: businessName }) : t('brandNoBusiness'),
    basisOriginal: t('basisOriginal'),
    basisWeight: (amount) => t('basisWeight', { amount }),
    basisLine: ({ name, amount }) => t('basisLine', { name, amount }),
    basisPreset: ({ summary, total }) => t('basisPreset', { summary, total }),
    presetItem: ({ quantity, name }) => t('presetItem', { quantity, name }),
    basisFactor: (factor) => t('basisFactor', { factor }),
    ingredient: t('ingredient'),
    quantity: t('quantity'),
    subRecipe: t('subRecipe'),
    totalToWeigh: t('totalToWeigh'),
    expectedFinishedWeight: t('expectedFinishedWeight'),
    method: t('method'),
    footer: (recipeName) => t('footer', { recipeName }),
    units: {
      weight: t('units.weight'),
      volume: t('units.volume'),
      count: t('units.count'),
    },
  };
}
