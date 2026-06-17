import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { customers, invoices } from '@/lib/db/schema';
import type { Customer } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { CustomerInput } from '@/lib/validation/invoices';

/**
 * Access to `customers` is ALWAYS org-scoped (RULE #1); RLS is the second layer.
 * Soft-delete: active reads filter `deleted_at IS NULL`; trashed customers surface
 * only through the trash-scoped reads. Customers are financial/billing data, so
 * every caller is already behind the manager-only RBAC gate.
 */

export async function listCustomers(
  db: TenantClient,
  organizationId: string,
): Promise<Customer[]> {
  return db
    .select()
    .from(customers)
    .where(
      and(eq(customers.organizationId, organizationId), isNull(customers.deletedAt)),
    )
    .orderBy(customers.name);
}

export async function getCustomerById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Customer | null> {
  const rows = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, organizationId),
        eq(customers.id, id),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createCustomer(
  db: TenantClient,
  organizationId: string,
  input: CustomerInput,
): Promise<Customer> {
  const [row] = await db
    .insert(customers)
    .values({ ...input, organizationId })
    .returning();
  if (!row) throw new Error('Failed to create customer.');
  return row;
}

export async function updateCustomer(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: CustomerInput,
): Promise<Customer | null> {
  const [row] = await db
    .update(customers)
    .set(input)
    .where(
      and(
        eq(customers.organizationId, organizationId),
        eq(customers.id, id),
        isNull(customers.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Moves an active customer to the trash. Returns null if it was not active. */
export async function softDeleteCustomer(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Customer | null> {
  const [row] = await db
    .update(customers)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(customers.organizationId, organizationId),
        eq(customers.id, id),
        isNull(customers.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Brings a trashed customer back. Returns null if it was not in the trash. */
export async function restoreCustomer(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Customer | null> {
  const [row] = await db
    .update(customers)
    .set({ deletedAt: null })
    .where(
      and(
        eq(customers.organizationId, organizationId),
        eq(customers.id, id),
        isNotNull(customers.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Permanently deletes a trashed customer. Any invoice that referenced it is
 * unlinked first (`customer_id` → NULL): the `invoices_customer_fk` is
 * `ON DELETE restrict`, so a referencing invoice would otherwise block the purge.
 * The invoice keeps its own customer SNAPSHOT, so the historical document still
 * shows who it was for. Runs in the caller's `withOrg` transaction (atomic).
 */
export async function purgeCustomer(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .update(invoices)
    .set({ customerId: null })
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.customerId, id),
      ),
    );

  await db
    .delete(customers)
    .where(
      and(
        eq(customers.organizationId, organizationId),
        eq(customers.id, id),
        isNotNull(customers.deletedAt),
      ),
    );
}

export async function listTrashedCustomers(
  db: TenantClient,
  organizationId: string,
): Promise<Customer[]> {
  return db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, organizationId),
        isNotNull(customers.deletedAt),
      ),
    )
    .orderBy(desc(customers.deletedAt));
}
