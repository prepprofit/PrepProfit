import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { ingredients, ingredientSuppliers, suppliers } from '@/lib/db/schema';
import type { Supplier } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { normalizeSupplierName } from '@/lib/suppliers/normalize';
import type { SupplierFormInput } from '@/lib/validation/suppliers';

/**
 * Suppliers data layer (Sprint 7). Always org-scoped (RULE #1); RLS is the second
 * layer. Suppliers are MANAGER-ONLY at the action layer and ARCHIVED, not trashed
 * (`active` flag, no `deleted_at`). The dedup key is `normalized_name`, written by
 * `normalizeSupplierName` at write time — SQL never re-derives it.
 */

export type SupplierWithCount = Supplier & { ingredientCount: number };

/**
 * Active suppliers first (then archived when `includeArchived`), alphabetical
 * within each group, each with how many ingredient links reference it.
 */
export async function listSuppliersWithCounts(
  db: TenantClient,
  organizationId: string,
  includeArchived = false,
): Promise<SupplierWithCount[]> {
  const rows = await db
    .select({
      supplier: suppliers,
      ingredientCount: sql<number>`count(${ingredientSuppliers.id})`,
    })
    .from(suppliers)
    .leftJoin(
      ingredientSuppliers,
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.supplierId, suppliers.id),
      ),
    )
    .where(
      includeArchived
        ? eq(suppliers.organizationId, organizationId)
        : and(
            eq(suppliers.organizationId, organizationId),
            eq(suppliers.active, true),
          ),
    )
    .groupBy(suppliers.id)
    .orderBy(desc(suppliers.active), asc(suppliers.name));

  return rows.map((r) => ({ ...r.supplier, ingredientCount: Number(r.ingredientCount) }));
}

export async function getSupplierById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Supplier | null> {
  const rows = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.organizationId, organizationId), eq(suppliers.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export type CreateSupplierResult =
  | { status: 'ok'; supplier: Supplier }
  | { status: 'invalid_name' }
  | { status: 'duplicate' };

/**
 * Create a supplier. Rejects an empty normalized key (F6 §2) and surfaces a
 * duplicate normalized name as `duplicate` (the unique constraint also backstops).
 */
export async function createSupplier(
  db: TenantClient,
  organizationId: string,
  input: SupplierFormInput,
): Promise<CreateSupplierResult> {
  const normalizedName = normalizeSupplierName(input.name);
  if (normalizedName === '') return { status: 'invalid_name' };

  const [row] = await db
    .insert(suppliers)
    .values({
      organizationId,
      name: input.name.trim(),
      normalizedName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      taxId: input.taxId ?? null,
      notes: input.notes ?? null,
    })
    .onConflictDoNothing({
      target: [suppliers.organizationId, suppliers.normalizedName],
    })
    .returning();
  if (!row) return { status: 'duplicate' };
  return { status: 'ok', supplier: row };
}

export type UpdateSupplierResult =
  | { status: 'ok'; supplier: Supplier }
  | { status: 'invalid_name' }
  | { status: 'duplicate' }
  | { status: 'not_found' };

/**
 * Update a supplier's name + contact fields. When the NAME changes, the dedup key
 * is recomputed (duplicate → `duplicate`) and the new name is PROPAGATED into the
 * legacy `ingredients.supplier` column on every ingredient for which this supplier
 * is the DEFAULT link (transition contract §7). Runs in the caller's `withOrg` tx.
 */
export async function updateSupplier(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: SupplierFormInput,
): Promise<UpdateSupplierResult> {
  const normalizedName = normalizeSupplierName(input.name);
  if (normalizedName === '') return { status: 'invalid_name' };

  const existing = await getSupplierById(db, organizationId, id);
  if (!existing) return { status: 'not_found' };

  // A name collision with a DIFFERENT supplier in the same org is a duplicate.
  if (normalizedName !== existing.normalizedName) {
    const clash = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.organizationId, organizationId),
          eq(suppliers.normalizedName, normalizedName),
        ),
      )
      .limit(1);
    if (clash[0] && clash[0].id !== id) return { status: 'duplicate' };
  }

  const name = input.name.trim();
  const [row] = await db
    .update(suppliers)
    .set({
      name,
      normalizedName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      taxId: input.taxId ?? null,
      notes: input.notes ?? null,
    })
    .where(and(eq(suppliers.organizationId, organizationId), eq(suppliers.id, id)))
    .returning();
  if (!row) return { status: 'not_found' };

  // Propagate the rename to the legacy mirror on default-linked ingredients.
  if (name !== existing.name) {
    await propagateDefaultSupplierName(db, organizationId, id, name);
  }
  return { status: 'ok', supplier: row };
}

/**
 * Sync `ingredients.supplier` to `name` for every ingredient whose DEFAULT supplier
 * link points at `supplierId` (transition contract §6/§7). Used on rename + when a
 * default link is set.
 */
export async function propagateDefaultSupplierName(
  db: TenantClient,
  organizationId: string,
  supplierId: string,
  name: string,
): Promise<void> {
  const links = await db
    .select({ ingredientId: ingredientSuppliers.ingredientId })
    .from(ingredientSuppliers)
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.supplierId, supplierId),
        eq(ingredientSuppliers.isDefault, true),
      ),
    );
  for (const { ingredientId } of links) {
    await db
      .update(ingredients)
      .set({ supplier: name })
      .where(
        and(
          eq(ingredients.organizationId, organizationId),
          eq(ingredients.id, ingredientId),
        ),
      );
  }
}

/** How many ingredients have `supplierId` as their DEFAULT link (archive guard). */
export async function countDefaultLinks(
  db: TenantClient,
  organizationId: string,
  supplierId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(ingredientSuppliers)
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.supplierId, supplierId),
        eq(ingredientSuppliers.isDefault, true),
      ),
    );
  return rows[0]?.value ?? 0;
}

export type ArchiveSupplierResult =
  | { status: 'ok'; supplier: Supplier }
  | { status: 'in_use'; defaultLinks: number }
  | { status: 'not_found' };

/**
 * Archive a supplier (`active = false`). REFUSES with `in_use` if it is the default
 * for any ingredient (§12.10) — the default must be replaced/removed first, so the
 * legacy mirror never points at an archived supplier. Runs in the caller's tx.
 */
export async function archiveSupplier(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<ArchiveSupplierResult> {
  const existing = await getSupplierById(db, organizationId, id);
  if (!existing) return { status: 'not_found' };

  const defaultLinks = await countDefaultLinks(db, organizationId, id);
  if (defaultLinks > 0) return { status: 'in_use', defaultLinks };

  const [row] = await db
    .update(suppliers)
    .set({ active: false })
    .where(and(eq(suppliers.organizationId, organizationId), eq(suppliers.id, id)))
    .returning();
  if (!row) return { status: 'not_found' };
  return { status: 'ok', supplier: row };
}

/** Reactivate an archived supplier (`active = true`). */
export async function reactivateSupplier(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Supplier | null> {
  const [row] = await db
    .update(suppliers)
    .set({ active: true })
    .where(and(eq(suppliers.organizationId, organizationId), eq(suppliers.id, id)))
    .returning();
  return row ?? null;
}

export type FindOrCreateSupplierResult =
  | { status: 'ok'; supplier: Supplier }
  | { status: 'inactive'; supplier: Supplier }
  | { status: 'invalid_name' };

/**
 * Atomic, inactive-aware find-or-create by name (§12.4, §12.11). Normalizes the
 * name (rejects the empty key), then `INSERT … ON CONFLICT (org, normalized_name)
 * DO NOTHING RETURNING`; if nothing was returned, REFETCHES the existing row
 * (never select-then-insert, so two concurrent callers converge on one row). An
 * existing ARCHIVED supplier returns `inactive` — callers must NOT silently attach
 * it (reactivation is an explicit manager action). MUST run inside `withOrg`.
 */
export async function findOrCreateSupplierByName(
  db: TenantClient,
  organizationId: string,
  name: string,
): Promise<FindOrCreateSupplierResult> {
  const normalizedName = normalizeSupplierName(name);
  if (normalizedName === '') return { status: 'invalid_name' };

  const [created] = await db
    .insert(suppliers)
    .values({ organizationId, name: name.trim(), normalizedName })
    .onConflictDoNothing({
      target: [suppliers.organizationId, suppliers.normalizedName],
    })
    .returning();
  if (created) return { status: 'ok', supplier: created };

  // Conflict → the row already exists; refetch it (never re-insert).
  const [existing] = await db
    .select()
    .from(suppliers)
    .where(
      and(
        eq(suppliers.organizationId, organizationId),
        eq(suppliers.normalizedName, normalizedName),
      ),
    )
    .limit(1);
  if (!existing) {
    // Extremely unlikely (the conflicting row was deleted between insert+select);
    // treat as invalid so the caller surfaces a clean error rather than crashing.
    return { status: 'invalid_name' };
  }
  return existing.active
    ? { status: 'ok', supplier: existing }
    : { status: 'inactive', supplier: existing };
}
