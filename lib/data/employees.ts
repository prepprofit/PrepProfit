import { and, asc, eq } from 'drizzle-orm';
import { employees } from '@/lib/db/schema';
import type { Employee } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { EmployeeInput } from '@/lib/validation/payroll';

/**
 * Access to `employees` is ALWAYS org-scoped (RULE #1); RLS is the second layer.
 * Employees are PII — every caller is behind the manager-only RBAC gate, and
 * employees are NOT soft-deletable (no shared 30-day trash for PII). "Removing"
 * one archives it (`active = false`, keeping its shift history); a separate
 * hard-delete cascades the shifts. Money (`hourlyRateCents`) is integer cents.
 */

export async function listEmployees(
  db: TenantClient,
  organizationId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Employee[]> {
  return db
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.organizationId, organizationId),
        opts.includeArchived ? undefined : eq(employees.active, true),
      ),
    )
    .orderBy(asc(employees.name));
}

export async function getEmployeeById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Employee | null> {
  const rows = await db
    .select()
    .from(employees)
    .where(
      and(eq(employees.organizationId, organizationId), eq(employees.id, id)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createEmployee(
  db: TenantClient,
  organizationId: string,
  input: EmployeeInput,
): Promise<Employee> {
  const [row] = await db
    .insert(employees)
    .values({ ...input, organizationId })
    .returning();
  if (!row) throw new Error('Failed to create employee.');
  return row;
}

export async function updateEmployee(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: EmployeeInput,
): Promise<Employee | null> {
  const [row] = await db
    .update(employees)
    .set(input)
    .where(and(eq(employees.organizationId, organizationId), eq(employees.id, id)))
    .returning();
  return row ?? null;
}

/** Archive (`active=false`) or reactivate an employee, keeping their shifts. */
export async function setEmployeeActive(
  db: TenantClient,
  organizationId: string,
  id: string,
  active: boolean,
): Promise<Employee | null> {
  const [row] = await db
    .update(employees)
    .set({ active })
    .where(and(eq(employees.organizationId, organizationId), eq(employees.id, id)))
    .returning();
  return row ?? null;
}

/** Permanently deletes an employee; their shifts cascade via the composite FK. */
export async function hardDeleteEmployee(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(employees)
    .where(and(eq(employees.organizationId, organizationId), eq(employees.id, id)))
    .returning({ id: employees.id });
  return rows.length > 0;
}
