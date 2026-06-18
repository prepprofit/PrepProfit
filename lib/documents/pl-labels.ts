import type { PlDocumentLabels } from './types';

/**
 * Build the localized label set for a P&L document from a next-intl translator
 * scoped to the `plDocument` namespace. Shared by the PDF renderer, the XLSX
 * builder, and the HTML print page so all three render identical wording.
 */
export function buildPlLabels(t: (key: string) => string): PlDocumentLabels {
  return {
    title: t('title'),
    period: t('period'),
    income: t('income'),
    expenses: t('expenses'),
    profit: t('profit'),
    byCategory: t('byCategory'),
    category: t('category'),
    amount: t('amount'),
    topProducts: t('topProducts'),
    product: t('product'),
    monthly: t('monthly'),
    month: t('month'),
    empty: t('empty'),
  };
}
