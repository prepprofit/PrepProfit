import { and, eq, inArray, isNotNull, lte, notExists, sql } from 'drizzle-orm';
import {
  customers,
  ingredients,
  inventoryMovements,
  invoices,
  menuItems,
  menus,
  productionItems,
  productions,
  purchaseOrderItems,
  purchaseOrders,
  receiptItems,
  recipeIngredients,
  recipeMedia,
  recipes,
  saleItems,
  taskLists,
  tasks,
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
  menus: number;
  productions: number;
  taskLists: number;
  recipes: number;
  ingredients: number;
  transactions: number;
  customers: number;
  invoices: number;
  /**
   * Storage keys of recipe-media objects whose DB rows were cascaded away by a
   * recipe purge (Fase 3 §6.4). The CALLER removes them from the bucket AFTER
   * the transaction commits — idempotent, best-effort, never inside the tx.
   */
  mediaStorageKeys: string[];
};

export async function purgeExpired(
  db: TenantClient,
  organizationId: string,
  cutoff: Date,
): Promise<PurgeResult> {
  // Menus + productions first (Sprint 10 / 11a): deleting an expired menu or
  // production cascades its line items (composite FKs), releasing any recipe those
  // lines pinned via the restrict FK — so a recipe whose ONLY menu/production
  // reference just expired becomes purgeable below.
  // A menu referenced by ANY sale line (Sprint 12a) is KEPT — the `sale_items_menu_fk`
  // restrict FK would otherwise block the delete, and a posted/void sale's line is
  // permanent history (the sale is never unlinked, unlike a task).
  const saleMenuPin = notExists(
    db
      .select({ one: sql`1` })
      .from(saleItems)
      .where(
        and(
          eq(saleItems.organizationId, organizationId),
          eq(saleItems.itemMenuId, menus.id),
        ),
      ),
  );
  const purgedMenus = await db
    .delete(menus)
    .where(
      and(
        eq(menus.organizationId, organizationId),
        isNotNull(menus.deletedAt),
        lte(menus.deletedAt, cutoff),
        saleMenuPin,
      ),
    )
    .returning({ id: menus.id });

  const purgedProductions = await db
    .delete(productions)
    .where(
      and(
        eq(productions.organizationId, organizationId),
        isNotNull(productions.deletedAt),
        lte(productions.deletedAt, cutoff),
      ),
    )
    .returning({ id: productions.id });

  // Expired task lists (Sprint 6): deleting a list cascades its tasks (composite FK),
  // releasing any recipe/ingredient those tasks pinned via the restrict source FKs —
  // so a recipe/ingredient whose only reference was a task in a now-purged list
  // becomes purgeable below.
  const purgedTaskLists = await db
    .delete(taskLists)
    .where(
      and(
        eq(taskLists.organizationId, organizationId),
        isNotNull(taskLists.deletedAt),
        lte(taskLists.deletedAt, cutoff),
      ),
    )
    .returning({ id: taskLists.id });

  // A recipe still referenced by ANY surviving menu_item OR production_item (an
  // active or not-yet-expired menu/production) is KEPT — the restrict FKs would
  // otherwise block its delete (D4/D5). Both pins define the purgeable-recipe
  // candidate set, used IDENTICALLY for the transaction unlink and the delete, so a
  // pinned recipe never loses its transaction links as a side effect.
  const menuPin = notExists(
    db
      .select({ one: sql`1` })
      .from(menuItems)
      .where(
        and(
          eq(menuItems.organizationId, organizationId),
          eq(menuItems.recipeId, recipes.id),
        ),
      ),
  );
  const productionPin = notExists(
    db
      .select({ one: sql`1` })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.organizationId, organizationId),
          eq(productionItems.recipeId, recipes.id),
        ),
      ),
  );
  // A recipe referenced by ANY sale line (Sprint 12a) is KEPT — the
  // `sale_items_recipe_fk` restrict FK blocks the delete and the sale line is
  // permanent history.
  const saleRecipePin = notExists(
    db
      .select({ one: sql`1` })
      .from(saleItems)
      .where(
        and(
          eq(saleItems.organizationId, organizationId),
          eq(saleItems.itemRecipeId, recipes.id),
        ),
      ),
  );
  const purgeableRecipeWhere = and(
    eq(recipes.organizationId, organizationId),
    isNotNull(recipes.deletedAt),
    lte(recipes.deletedAt, cutoff),
    menuPin,
    productionPin,
    saleRecipePin,
  );

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
          db.select({ id: recipes.id }).from(recipes).where(purgeableRecipeWhere),
        ),
      ),
    );

  // Null any prep-task link pointing at a recipe about to be purged (→ plain text,
  // source_kind 'manual') — the `tasks_source_recipe_fk` is `ON DELETE restrict`, so
  // it would otherwise block the recipe delete (Sprint 6 L4). Same candidate set as
  // the transaction unlink, so a pinned recipe never loses its task links.
  await db
    .update(tasks)
    .set({ sourceKind: 'manual', sourceRecipeId: null })
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        isNotNull(tasks.sourceRecipeId),
        inArray(
          tasks.sourceRecipeId,
          db.select({ id: recipes.id }).from(recipes).where(purgeableRecipeWhere),
        ),
      ),
    );

  // Collect the media storage keys BEFORE the recipe delete cascades the
  // recipe_media rows away — the caller removes the bucket objects post-commit.
  const mediaKeyRows = await db
    .select({ storageKey: recipeMedia.storageKey })
    .from(recipeMedia)
    .where(
      and(
        eq(recipeMedia.organizationId, organizationId),
        inArray(
          recipeMedia.recipeId,
          db.select({ id: recipes.id }).from(recipes).where(purgeableRecipeWhere),
        ),
      ),
    );

  // Recipes (excluding any still pinned by a surviving menu): deleting a recipe
  // cascades its lines (composite FK), freeing any ingredient those lines pinned via
  // the `ON DELETE restrict` FK.
  const purgedRecipes = await db
    .delete(recipes)
    .where(purgeableRecipeWhere)
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
  // An ingredient consumed by a completed (stock-moving) production has permanent
  // ledger history (a `production`-sourced OUT movement). It is KEPT, never purged
  // (Sprint 11b D6) — the movement's restrict FK from production_consumptions would
  // otherwise block the cascade. Financial-only completions post no movement and so
  // do not pin the ingredient.
  const productionMovementPin = notExists(
    db
      .select({ one: sql`1` })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, organizationId),
          eq(inventoryMovements.ingredientId, ingredients.id),
          eq(inventoryMovements.sourceType, 'production'),
        ),
      ),
  );
  // An ingredient sold directly on any sale line (Sprint 12a) is KEPT (restrict FK +
  // permanent history)...
  const saleLinePin = notExists(
    db
      .select({ one: sql`1` })
      .from(saleItems)
      .where(
        and(
          eq(saleItems.organizationId, organizationId),
          eq(saleItems.itemIngredientId, ingredients.id),
        ),
      ),
  );
  // ...as is one consumed by a posted (stock-moving) sale via a `sale`-sourced OUT
  // movement (the production-movement-pin rationale). Financial-only sales post no
  // movement and so do not pin the ingredient.
  const saleMovementPin = notExists(
    db
      .select({ one: sql`1` })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, organizationId),
          eq(inventoryMovements.ingredientId, ingredients.id),
          eq(inventoryMovements.sourceType, 'sale'),
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
                productionMovementPin,
                saleLinePin,
                saleMovementPin,
              ),
            ),
        ),
      ),
    );

  // Null any reorder-task link pointing at an ingredient about to be purged (→ plain
  // text) — the `tasks_source_ingredient_fk` is `ON DELETE restrict` (Sprint 6 L4).
  // Same candidate set as the ingredient delete below, so a kept ingredient never
  // loses its task links.
  await db
    .update(tasks)
    .set({ sourceKind: 'manual', sourceIngredientId: null })
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        isNotNull(tasks.sourceIngredientId),
        inArray(
          tasks.sourceIngredientId,
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
                productionMovementPin,
                saleLinePin,
                saleMovementPin,
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
        productionMovementPin,
        saleLinePin,
        saleMovementPin,
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
    menus: purgedMenus.length,
    productions: purgedProductions.length,
    taskLists: purgedTaskLists.length,
    recipes: purgedRecipes.length,
    ingredients: purgedIngredients.length,
    transactions: purgedTransactions.length,
    customers: purgedCustomers.length,
    invoices: purgedInvoices.length,
    mediaStorageKeys: mediaKeyRows.map((r) => r.storageKey),
  };
}
