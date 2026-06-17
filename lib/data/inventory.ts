import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { ingredients, inventoryMovements } from '@/lib/db/schema';
import type { Ingredient, InventoryMovement } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Inventory access is ALWAYS scoped by `organizationId`. Stock lives on the
 * ingredient row; every change is also appended to the inventory_movements
 * ledger in the SAME transaction (callers wrap these in `withOrg`).
 */

export type RecordMovementInput = {
  ingredientId: string;
  /** Signed canonical change: positive = stock in, negative = stock out. */
  deltaCanonical: number;
  note?: string | null;
};

/**
 * Append a movement and update the running stock total atomically. Stock is
 * clamped at zero (you cannot have negative physical stock). Returns the updated
 * ingredient, or null if it does not belong to the org or is in the trash.
 *
 * The ingredient UPDATE runs FIRST: if it affects no row (wrong org or
 * `deleted_at IS NOT NULL`), we bail out before writing anything, so a trashed
 * or foreign ingredient can never accumulate an orphan ledger entry.
 */
export async function recordMovement(
  db: TenantClient,
  organizationId: string,
  input: RecordMovementInput,
): Promise<Ingredient | null> {
  const [row] = await db
    .update(ingredients)
    .set({
      stockQuantity: sql`GREATEST(${ingredients.stockQuantity} + ${input.deltaCanonical.toString()}::numeric, 0)`,
    })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, input.ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  if (!row) return null;

  await db.insert(inventoryMovements).values({
    organizationId,
    ingredientId: input.ingredientId,
    deltaCanonical: input.deltaCanonical.toString(),
    note: input.note ?? null,
  });
  return row;
}

export async function setLowStockThreshold(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  thresholdCanonical: number | null,
): Promise<Ingredient | null> {
  const [row] = await db
    .update(ingredients)
    .set({
      lowStockThreshold:
        thresholdCanonical == null ? null : thresholdCanonical.toString(),
    })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function listMovements(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  limit = 20,
): Promise<InventoryMovement[]> {
  return db
    .select()
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.ingredientId, ingredientId),
      ),
    )
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(limit);
}
