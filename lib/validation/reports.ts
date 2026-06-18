import { z } from 'zod';
import { isValidPeriodKey, type PeriodView } from '@/lib/finance/period';
import { isValidAnchor } from '@/lib/payroll/period';

/**
 * Server-side validation for report export filters (Sprint 3.5B). Document routes
 * (P&L / payroll PDF + XLSX) take the same period inputs as their on-screen pages
 * (`/financials`, `/payroll`) from query params, so the export reconciles with what
 * the user sees. RULE: all client input is Zod-validated on the server; a malformed
 * filter yields a 400 rather than silently mis-querying.
 *
 * `view` defaults to the page default when absent. `period`/`d` default to the
 * current period in the route when absent, so they are optional here and only
 * rejected when present-but-malformed.
 */

/** P&L (financials) period filter: 'month'|'year' + a matching period key. */
export const plReportFilterSchema = z
  .object({
    view: z.enum(['month', 'year']).default('month'),
    period: z.string().optional(),
  })
  .refine(
    (v) => v.period === undefined || isValidPeriodKey(v.view as PeriodView, v.period),
    { path: ['period'], message: 'period does not match the selected view' },
  );

export type PlReportFilter = z.infer<typeof plReportFilterSchema>;

/** Payroll period filter: 'week'|'month' + a 'YYYY-MM-DD' anchor date. */
export const payrollReportFilterSchema = z.object({
  view: z.enum(['week', 'month']).default('month'),
  d: z
    .string()
    .refine((v) => isValidAnchor(v), { message: 'd must be a YYYY-MM-DD date' })
    .optional(),
});

export type PayrollReportFilter = z.infer<typeof payrollReportFilterSchema>;
