import { z } from 'zod';

/**
 * Server-side validation for employees and shifts (CLAUDE.md: Zod on all user
 * input, on the server). Employees are PII — every caller is behind the
 * manager-only RBAC gate. The org id is derived from Clerk, never in the payload.
 *
 * Shift instants are passed as epoch MILLISECONDS (the client converts its
 * datetime-local inputs with `Date.getTime()`), matching the pure payroll calc —
 * so there is no ambiguous timezone-less string anywhere on the wire.
 */

export const employeeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z
    .union([z.literal(''), z.string().trim().email().max(200)])
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .default(null),
  // Hourly rate in integer cents.
  hourlyRateCents: z.number().int().min(0).max(1_000_000_000),
});

export const shiftSchema = z
  .object({
    employeeId: z.string().min(1),
    // Check-in / check-out as epoch milliseconds; end is null while open.
    startedAtMs: z.number().int(),
    endedAtMs: z.number().int().nullable().default(null),
    // Unpaid break in minutes (0 .. 24h).
    breakMinutes: z.number().int().min(0).max(24 * 60),
    note: z
      .string()
      .trim()
      .max(300)
      .transform((s) => (s === '' ? null : s))
      .nullable()
      .default(null),
  })
  // A closed shift must end at or after it starts (open shifts have no end yet).
  .refine((s) => s.endedAtMs === null || s.endedAtMs >= s.startedAtMs, {
    message: 'A shift cannot end before it starts.',
    path: ['endedAtMs'],
  });

export type EmployeeInput = z.infer<typeof employeeSchema>;
export type ShiftInput = z.infer<typeof shiftSchema>;
