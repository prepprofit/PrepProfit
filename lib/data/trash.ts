import { and, eq, inArray, isNotNull, lte, notExists, sql } from 'drizzle-orm';
import {
  customers,
  ingredients,
  invoices,
  purchaseOrderItems,
  purchaseOrders,
  receiptItems,
  recipeIngredients,
  recipes,
  transactions,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Permanent deletion of trash that has outlived the retention window. Always
 * org-scoped (RULE #1) — the auto-purge cron calls this once per organization
 * inside `withOrg`, so RLS stays active and no policy carve-out is needed.
 *
 * `cutoff` comes from {@link purgeCutoff} in lib/trash.ts: rows with
 * `deleted_at <= cutoff` are expired.
 */
export type PurgeResult = {
  recipes: number;
  ingredients: number;
  transactions: number;
  customers: number;
  invoices: number;
};

export async function purgeExpired(
  db: TenantClient,
  organizationId: string,
  cutoff: Date,
): Promise<PurgeResult> {
  // Unlink any transaction pointing at a recipe about to be purged — the
  // `transactions_recipe_fk` is `ON DELETE restrict`, so it would otherwise block
  // the recipe delete. The financial record survives with `recipe_id` = NULL.
  await db
    .update(transactions)
    .set({ recipeId: null })
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        isNotNull(transactions.recipeId),
        inArray(
          transactions.recipeId,
          db
            .select({ id: recipes.id })
            .from(recipes)
            .where(
              and(
                eq(recipes.organizationId, organizationId),
                isNotNull(recipes.deletedAt),
                lte(recipes.deletedAt, cutoff),
              ),
            ),
        ),
      ),
    );

  // Recipes first: deleting a recipe cascades its lines (composite FK), freeing
  // any ingredient those lines pinned via the `ON DELETE restrict` FK.
  const purgedRecipes = await db
    .delete(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        isNotNull(recipes.deletedAt),
        lte(recipes.deletedAt, cutoff),
      ),
    )
    .returning({ id: recipes.id });

  // An ingredient referenced by a NON-DRAFT purchase order (anything past `draft`:
  // sent / partially_received / received / cancelled) is a historical document master
  // — F3 Policy B: it is KEPT, never hard-purged. A DRAFT-only reference may be purged
  // after the draft link is nulled (no history at stake). An ingredient on any goods
  // RECEIPT line is likewise kept (Sprint 8b): the receipt + its IN movement are
  // permanent inventory history. All checks are correlated NOT EXISTS so the ingredient
  // delete skips a kept ingredient instead of hitting the restrict FK.
  const recipePin = notExists(
    db
      .select({ one: sql`1` })
      .from(recipeIngredients)
      .where(
        and(
          eq(recipeIngredients.organizationId, organizationId),
          eq(recipeIngredients.ingredientId, ingredients.id),
        ),
      ),
  );
  const nonDraftPoPin = notExists(
    db
      .select({ one: sql`1` })
      .from(purchaseOrderItems)
      .innerJoin(
        purchaseOrders,
        and(
          eq(purchaseOrders.organizationId, organizationId),
          eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId),
        ),
      )
      .where(
        and(
          eq(purchaseOrderItems.organizationId, organizationId),
          eq(purchaseOrderItems.ingredientId, ingredients.id),
          sql`${purchaseOrders.status} <> 'draft'`,
        ),
      ),
  );
  const receiptPin = notExists(
    db
      .select({ one: sql`1` })
      .from(receiptItems)
      .where(
        and(
          eq(receiptItems.organizationId, organizationId),
          eq(receiptItems.ingredientId, ingredients.id),
        ),
      ),
  );

  // Null the DRAFT purchase-order line links pointing at an ingredient that is about
  // to be purged (matching the exact delete set), so the `restrict` FK does not block
  // the delete. A draft that loses a line ref is acceptable — no document history.
  await db
    .update(purchaseOrderItems)
    .set({ ingredientId: null })
    .where(
      and(
        eq(purchaseOrderItems.organizationId, organizationId),
        isNotNull(purchaseOrderItems.ingredientId),
        inArray(
          purchaseOrderItems.ingredientId,
          db
            .select({ id: ingredients.id })
            .from(ingredients)
            .where(
              and(
                eq(ingredients.organizationId, organizationId),
                isNotNull(ingredients.deletedAt),
                lte(ingredients.deletedAt, cutoff),
                recipePin,
                nonDraftPoPin,
                receiptPin,
              ),
            ),
        ),
      ),
    );

  // Then expired ingredients, skipping any still referenced by a (trashed) recipe
  // line, a non-draft PO, or a goods receipt — that recipe purges on its own expiry;
  // a non-draft PO / receipt keeps the ingredient indefinitely (F3). The NOT EXISTS
  // avoids the restrict FK.
  const purgedIngredients = await db
    .delete(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNotNull(ingredients.deletedAt),
        lte(ingredients.deletedAt, cutoff),
        recipePin,
        nonDraftPoPin,
        receiptPin,
      ),
    )
    .returning({ id: ingredients.id });

  // Expired trashed transactions have no dependents — delete them directly.
  // EXCEPT sale-sourced rows (Sprint F5): a voided sale's income row is a
  // permanent historical projection, never garbage-collected. `IS DISTINCT FROM`
  // (not `<>`) so the NULL-source normal rows are still purged.
  const purgedTransactions = await db
    .delete(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        isNotNull(transactions.deletedAt),
        lte(transactions.deletedAt, cutoff),
        sql`${transactions.sourceType} is distinct from 'sale'`,
      ),
    )
    .returning({ id: transactions.id });

  // Unlink any invoice pointing at a customer about to be purged — the
  // `invoices_customer_fk` is `ON DELETE restrict`, so it would otherwise block
  // the customer delete. The invoice keeps its frozen customer snapshot.
  await db
    .update(invoices)
    .set({ customerId: null })
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        isNotNull(invoices.customerId),
        inArray(
          invoices.customerId,
          db
            .select({ id: customers.id })
            .from(customers)
            .where(
              and(
                eq(customers.organizationId, organizationId),
                isNotNull(customers.deletedAt),
                lte(customers.deletedAt, cutoff),
              ),
            ),
        ),
      ),
    );

  // Expired trashed (draft) invoices — their line items cascade via the FK.
  const purgedInvoices = await db
    .delete(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        isNotNull(invoices.deletedAt),
        lte(invoices.deletedAt, cutoff),
      ),
    )
    .returning({ id: invoices.id });

  // Then expired trashed customers (their invoice links were just nulled).
  const purgedCustomers = await db
    .delete(customers)
    .where(
      and(
        eq(customers.organizationId, organizationId),
        isNotNull(customers.deletedAt),
        lte(customers.deletedAt, cutoff),
      ),
    )
    .returning({ id: customers.id });

  return {
    recipes: purgedRecipes.length,
    ingredients: purgedIngredients.length,
    transactions: purgedTransactions.length,
    customers: purgedCustomers.length,
    invoices: purgedInvoices.length,
  };
}
