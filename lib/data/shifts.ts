import { and, asc, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import { shifts } from '@/lib/db/schema';
import type { Shift } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { ShiftInput } from '@/lib/validation/payroll';

/**
 * Access to `shifts` is ALWAYS org-scoped (RULE #1); RLS is the second layer.
 * Shifts store absolute timestamptz instants (see lib/calculations/payroll.ts),
 * so a shift crossing midnight needs no special handling. Every caller is behind
 * the manager-only RBAC gate (payroll is PII / financial).
 */

/** Maps validated input (epoch ms) to the Date/column shape the DB expects. */
function toRow(input: ShiftInput) {
  return {
    employeeId: input.employeeId,
    startedAt: new Date(input.startedAtMs),
    endedAt: input.endedAtMs === null ? null : new Date(input.endedAtMs),
    breakMinutes: input.breakMinutes,
    note: input.note,
  };
}

/**
 * Shifts for one employee whose START falls in the half-open period [from, to),
 * newest first. `from`/`to` are instants (the page derives them from the chosen
 * week/month); a shift is attributed to the period it started in.
 */
export async function listShiftsForEmployee(
  db: TenantClient,
  organizationId: string,
  employeeId: string,
  range?: { fromMs: number; toMs: number },
): Promise<Shift[]> {
  return db
    .select()
    .from(shifts)
    .where(
      and(
        eq(shifts.organizationId, organizationId),
        eq(shifts.employeeId, employeeId),
        range ? gte(shifts.startedAt, new Date(range.fromMs)) : undefined,
        range ? lt(shifts.startedAt, new Date(range.toMs)) : undefined,
      ),
    )
    .orderBy(desc(shifts.startedAt));
}

/** All shifts in the org for a period (start in [from, to)), oldest first. */
export async function listShiftsInPeriod(
  db: TenantClient,
  organizationId: string,
  range: { fromMs: number; toMs: number },
): Promise<Shift[]> {
  return db
    .select()
    .from(shifts)
    .where(
      and(
        eq(shifts.organizationId, organizationId),
        gte(shifts.startedAt, new Date(range.fromMs)),
        lt(shifts.startedAt, new Date(range.toMs)),
      ),
    )
    .orderBy(asc(shifts.startedAt));
}

export async function getShiftById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Shift | null> {
  const rows = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.organizationId, organizationId), eq(shifts.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/** Logs a shift (check-in, optionally already closed). The composite FK rejects
 *  a cross-tenant / non-existent employee link. */
export async function createShift(
  db: TenantClient,
  organizationId: string,
  input: ShiftInput,
): Promise<Shift> {
  const [row] = await db
    .insert(shifts)
    .values({ ...toRow(input), organizationId })
    .returning();
  if (!row) throw new Error('Failed to create shift.');
  return row;
}

export async function updateShift(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: ShiftInput,
): Promise<Shift | null> {
  const [row] = await db
    .update(shifts)
    .set(toRow(input))
    .where(and(eq(shifts.organizationId, organizationId), eq(shifts.id, id)))
    .returning();
  return row ?? null;
}

/**
 * Closes an OPEN shift by stamping its end instant. The `endedAt IS NULL`
 * predicate makes this idempotent and tamper-resistant: a repeated or forged
 * close matches no row (returns null) and can never rewrite an already-closed,
 * payroll-relevant end time.
 */
export async function closeShift(
  db: TenantClient,
  organizationId: string,
  id: string,
  endedAtMs: number,
): Promise<Shift | null> {
  const [row] = await db
    .update(shifts)
    .set({ endedAt: new Date(endedAtMs) })
    .where(
      and(
        eq(shifts.organizationId, organizationId),
        eq(shifts.id, id),
        isNull(shifts.endedAt),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteShift(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(shifts)
    .where(and(eq(shifts.organizationId, organizationId), eq(shifts.id, id)))
    .returning({ id: shifts.id });
  return rows.length > 0;
}
