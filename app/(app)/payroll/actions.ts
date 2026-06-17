'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isForeignKeyViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import {
  createEmployee,
  hardDeleteEmployee,
  setEmployeeActive,
  updateEmployee,
} from '@/lib/data/employees';
import {
  closeShift,
  createShift,
  deleteShift,
  getShiftById,
  updateShift,
} from '@/lib/data/shifts';
import { employeeSchema, shiftSchema } from '@/lib/validation/payroll';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for payroll (module 5). RULE #1: org id from Clerk on the server,
 * every write inside `withOrg` (RLS active), Zod on the input. Employees are PII /
 * financial data — every action returns FORBIDDEN for non-managers BEFORE any data
 * access. A cross-tenant employee link on a shift is rejected by the composite FK.
 */

function revalidatePayroll(): void {
  revalidatePath('/payroll');
}

export async function createEmployeeAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = employeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      createEmployee(tx, organizationId, parsed.data),
    );
    revalidatePayroll();
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    return unexpected('createEmployeeAction', err, organizationId);
  }
}

export async function updateEmployeeAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = employeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    updateEmployee(tx, organizationId, id, parsed.data),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidatePayroll();
  return { ok: true, data: undefined };
}

/** Archive (default) or reactivate an employee. */
export async function setEmployeeActiveAction(
  id: string,
  active: boolean,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    setEmployeeActive(tx, organizationId, id, active),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidatePayroll();
  return { ok: true, data: undefined };
}

/** Permanently delete an employee and cascade their shifts. */
export async function deleteEmployeeAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const deleted = await withOrg(organizationId, (tx) =>
    hardDeleteEmployee(tx, organizationId, id),
  );
  if (!deleted) return { ok: false, code: 'NOT_FOUND' };
  revalidatePayroll();
  return { ok: true, data: undefined };
}

export async function createShiftAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = shiftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      createShift(tx, organizationId, parsed.data),
    );
    revalidatePayroll();
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    // Composite FK: an employee link from another org (or a vanished employee).
    if (isForeignKeyViolation(err)) return { ok: false, code: 'NOT_FOUND' };
    return unexpected('createShiftAction', err, organizationId);
  }
}

export async function updateShiftAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = shiftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      updateShift(tx, organizationId, id, parsed.data),
    );
    if (!row) return { ok: false, code: 'NOT_FOUND' };
  } catch (err) {
    if (isForeignKeyViolation(err)) return { ok: false, code: 'NOT_FOUND' };
    return unexpected('updateShiftAction', err, organizationId);
  }
  revalidatePayroll();
  return { ok: true, data: undefined };
}

const closeShiftSchema = z.object({ endedAtMs: z.number().int() });

/** Stamps an open shift's check-out instant (must be at/after its start). */
export async function closeShiftAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = closeShiftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, async (tx) => {
    const shift = await getShiftById(tx, organizationId, id);
    if (!shift) return { status: 'not_found' as const };
    if (parsed.data.endedAtMs < shift.startedAt.getTime()) {
      return { status: 'invalid' as const };
    }
    const updated = await closeShift(tx, organizationId, id, parsed.data.endedAtMs);
    return { status: 'ok' as const, updated };
  });

  if (row.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (row.status === 'invalid') return { ok: false, code: 'INVALID_INPUT' };
  revalidatePayroll();
  return { ok: true, data: undefined };
}

export async function deleteShiftAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const deleted = await withOrg(organizationId, (tx) =>
    deleteShift(tx, organizationId, id),
  );
  if (!deleted) return { ok: false, code: 'NOT_FOUND' };
  revalidatePayroll();
  return { ok: true, data: undefined };
}
