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

export type RecordMovementResult =
  | { ok: true; ingredient: Ingredient }
  | { ok: false; reason: 'not_found' | 'insufficient_stock' };

/**
 * Append a movement and update the running stock total atomically. The ledger is
 * AUTHORITATIVE: every entry is a real, fully-applied movement, so a stock-out
 * larger than what's on hand is REJECTED rather than silently clamped (which
 * would record a delta the stock never actually moved by — the two would stop
 * reconciling). Returns:
 *   - `not_found`         — wrong org, or the ingredient is in the trash;
 *   - `insufficient_stock`— the stock-out would drive stock below zero.
 *
 * The active ingredient row is locked FOR UPDATE first, so the available-stock
 * check and the write are consistent even under concurrent movements; a foreign
 * or trashed ingredient never accumulates an orphan ledger entry.
 */
export async function recordMovement(
  db: TenantClient,
  organizationId: string,
  input: RecordMovementInput,
): Promise<RecordMovementResult> {
  const [current] = await db
    .select({ stock: ingredients.stockQuantity })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, input.ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .for('update')
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  if (Number(current.stock) + input.deltaCanonical < 0) {
    return { ok: false, reason: 'insufficient_stock' };
  }

  const [row] = await db
    .update(ingredients)
    .set({
      stockQuantity: sql`${ingredients.stockQuantity} + ${input.deltaCanonical.toString()}::numeric`,
    })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, input.ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  if (!row) return { ok: false, reason: 'not_found' };

  await db.insert(inventoryMovements).values({
    organizationId,
    ingredientId: input.ingredientId,
    deltaCanonical: input.deltaCanonical.toString(),
    note: input.note ?? null,
  });
  return { ok: true, ingredient: row };
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
        isNull(ingredients.deletedAt),
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
