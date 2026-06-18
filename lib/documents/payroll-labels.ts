import type { PayrollDocumentLabels } from './types';

/**
 * Build the localized label set for a payroll summary document from a next-intl
 * translator scoped to the `payrollDocument` namespace. Shared by the PDF renderer,
 * the XLSX builder, and the print page so all three render identical wording.
 */
export function buildPayrollLabels(
  t: (key: string) => string,
): PayrollDocumentLabels {
  return {
    title: t('title'),
    period: t('period'),
    employee: t('employee'),
    shifts: t('shifts'),
    hours: t('hours'),
    pay: t('pay'),
    total: t('total'),
    empty: t('empty'),
  };
}
