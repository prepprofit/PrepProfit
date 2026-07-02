import { z } from 'zod';

/**
 * Server-side validation for the Weekly CFO Report (Sprint 8). CLAUDE.md: Zod on all user
 * input, on the server. The org id is never part of the payload (derived from Clerk). The
 * only input is the optional week-ending date; when omitted the loader defaults to the last
 * full 7 days.
 */

/** A bare 'YYYY-MM-DD' calendar date (matches `sales.sale_date`). */
const ymd = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const cfoReportSchema = z.object({
  /** The week-ending date; the report covers the 7 days ending on (and including) it. */
  weekTo: ymd.optional(),
});
export type CfoReportRequest = z.infer<typeof cfoReportSchema>;
