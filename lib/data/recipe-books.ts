import { and, asc, count, eq, inArray, isNull, max, notInArray } from 'drizzle-orm';
import { recipeBooks, recipeBookEntries, recipes } from '@/lib/db/schema';
import type { RecipeBook } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Access to `recipe_books` / `recipe_book_entries` is ALWAYS scoped by
 * `organizationId` (RULE #1) — derived on the server, never trusted from the
 * client; RLS is the second layer.
 *
 * Books are the Recipes 2.0 organizer: a flat, per-org namespace like folders,
 * but MANY-TO-MANY with recipes via `recipe_book_entries`. During the Fase 7
 * coexistence window (decision D2) folders stay live; the legacy folder move
 * write-through ({@link syncBookMembershipForFolderMove}) keeps the homonymous
 * book's membership in parity so both organizers tell the same story. A folder
 * RENAME is deliberately not mirrored — the pair simply diverges into two
 * independent books, which is harmless (books are additive).
 *
 * Books are HARD-deleted; entries go with them via `ON DELETE cascade`.
 * Trashed recipes KEEP their memberships (restore brings a recipe back into
 * its books) — active-recipe counts simply exclude them.
 */

/** A book plus how many ACTIVE recipes it holds (trashed ones never count). */
export type BookWithCount = {
  id: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  recipeCount: number;
};

export async function listBooks(
  db: TenantClient,
  organizationId: string,
): Promise<RecipeBook[]> {
  return db
    .select()
    .from(recipeBooks)
    .where(eq(recipeBooks.organizationId, organizationId))
    .orderBy(recipeBooks.sortOrder, recipeBooks.name);
}

/**
 * Books with per-book ACTIVE-recipe counts. Two org-scoped queries (the books,
 * then a grouped count over entries joined to active recipes) — no N+1.
 */
export async function listBooksWithCounts(
  db: TenantClient,
  organizationId: string,
): Promise<BookWithCount[]> {
  const books = await listBooks(db, organizationId);

  const countRows = await db
    .select({ bookId: recipeBookEntries.recipeBookId, value: count() })
    .from(recipeBookEntries)
    .innerJoin(
      recipes,
      and(
        eq(recipes.organizationId, recipeBookEntries.organizationId),
        eq(recipes.id, recipeBookEntries.recipeId),
      ),
    )
    .where(
      and(
        eq(recipeBookEntries.organizationId, organizationId),
        isNull(recipes.deletedAt),
      ),
    )
    .groupBy(recipeBookEntries.recipeBookId);
  const byBook = new Map(countRows.map((r) => [r.bookId, r.value]));

  return books.map((b) => ({
    id: b.id,
    name: b.name,
    icon: b.icon,
    sortOrder: b.sortOrder,
    recipeCount: byBook.get(b.id) ?? 0,
  }));
}

/**
 * Book ids per recipe for a set of recipes, for the library table's "Books"
 * column. One org-scoped query; recipes with no book are simply absent.
 */
export async function loadBookIdsByRecipe(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, string[]>> {
  if (recipeIds.length === 0) return new Map();
  const rows = await db
    .select({
      recipeId: recipeBookEntries.recipeId,
      bookId: recipeBookEntries.recipeBookId,
    })
    .from(recipeBookEntries)
    .where(
      and(
        eq(recipeBookEntries.organizationId, organizationId),
        inArray(recipeBookEntries.recipeId, recipeIds),
      ),
    );
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.recipeId);
    if (list) list.push(row.bookId);
    else map.set(row.recipeId, [row.bookId]);
  }
  return map;
}

/**
 * Creates a book at the end of the rail. `sort_order` = (current max) + 1 so
 * books keep distinct, append-only positions even after deletions. A duplicate
 * name raises a unique violation the action surfaces.
 */
export async function createBook(
  db: TenantClient,
  organizationId: string,
  name: string,
  icon: string | null = null,
): Promise<RecipeBook> {
  const [maxRow] = await db
    .select({ value: max(recipeBooks.sortOrder) })
    .from(recipeBooks)
    .where(eq(recipeBooks.organizationId, organizationId));
  const nextOrder = maxRow?.value == null ? 0 : maxRow.value + 1;

  const [row] = await db
    .insert(recipeBooks)
    .values({ organizationId, name, icon, sortOrder: nextOrder })
    .returning();
  if (!row) throw new Error('Failed to create book.');
  return row;
}

/**
 * Updates a book's name and icon. Returns null if it does not exist; a unique
 * violation (duplicate name) bubbles up to the action.
 */
export async function updateBook(
  db: TenantClient,
  organizationId: string,
  id: string,
  name: string,
  icon: string | null = null,
): Promise<RecipeBook | null> {
  const [row] = await db
    .update(recipeBooks)
    .set({ name, icon })
    .where(
      and(eq(recipeBooks.organizationId, organizationId), eq(recipeBooks.id, id)),
    )
    .returning();
  return row ?? null;
}

/**
 * Moves a book one slot up or down by swapping its `sort_order` with the
 * adjacent book's. Returns false at the ends (nothing to swap) or if the book
 * is gone. Both updates run in the caller's `withOrg` transaction.
 */
export async function reorderBook(
  db: TenantClient,
  organizationId: string,
  id: string,
  direction: 'up' | 'down',
): Promise<boolean> {
  const ordered = await db
    .select({ id: recipeBooks.id, sortOrder: recipeBooks.sortOrder })
    .from(recipeBooks)
    .where(eq(recipeBooks.organizationId, organizationId))
    .orderBy(recipeBooks.sortOrder, recipeBooks.name);

  const index = ordered.findIndex((b) => b.id === id);
  if (index === -1) return false;
  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= ordered.length) return false;

  const current = ordered[index]!;
  const neighbour = ordered[swapIndex]!;

  await db
    .update(recipeBooks)
    .set({ sortOrder: neighbour.sortOrder })
    .where(
      and(
        eq(recipeBooks.organizationId, organizationId),
        eq(recipeBooks.id, current.id),
      ),
    );
  await db
    .update(recipeBooks)
    .set({ sortOrder: current.sortOrder })
    .where(
      and(
        eq(recipeBooks.organizationId, organizationId),
        eq(recipeBooks.id, neighbour.id),
      ),
    );
  return true;
}

/**
 * Hard-deletes a book; its entries go via `ON DELETE cascade`. Recipes are
 * untouched (membership is additive metadata). Returns false if the book did
 * not exist.
 */
export async function deleteBook(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(recipeBooks)
    .where(
      and(eq(recipeBooks.organizationId, organizationId), eq(recipeBooks.id, id)),
    )
    .returning({ id: recipeBooks.id });
  return deleted.length > 0;
}

/**
 * Atomically replaces ONE recipe's book memberships with `bookIds`. Locks the
 * active recipe FOR UPDATE so two concurrent replaces serialize instead of
 * interleaving delete/insert; returns false (no writes) if the recipe is not
 * an active same-org recipe. A non-existent or cross-tenant book id raises the
 * composite-FK violation the action surfaces. `bookIds` must be distinct.
 */
export async function setRecipeBooks(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  bookIds: string[],
): Promise<boolean> {
  const locked = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, recipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .for('update');
  if (locked.length === 0) return false;

  if (bookIds.length === 0) {
    await db
      .delete(recipeBookEntries)
      .where(
        and(
          eq(recipeBookEntries.organizationId, organizationId),
          eq(recipeBookEntries.recipeId, recipeId),
        ),
      );
    return true;
  }

  await db
    .delete(recipeBookEntries)
    .where(
      and(
        eq(recipeBookEntries.organizationId, organizationId),
        eq(recipeBookEntries.recipeId, recipeId),
        notInArray(recipeBookEntries.recipeBookId, bookIds),
      ),
    );
  await db
    .insert(recipeBookEntries)
    .values(
      bookIds.map((bookId) => ({
        organizationId,
        recipeBookId: bookId,
        recipeId,
      })),
    )
    .onConflictDoNothing({
      target: [
        recipeBookEntries.organizationId,
        recipeBookEntries.recipeBookId,
        recipeBookEntries.recipeId,
      ],
    });
  return true;
}

/** Outcome of a bulk membership write: which of the requested recipes were eligible. */
export type BulkBookResult = {
  /** Requested recipe ids that are active, same-org recipes (the ones written). */
  affectedIds: string[];
  /** Requested recipe ids that were missing, trashed, or cross-org (skipped). */
  skippedIds: string[];
};

/**
 * Locks and returns the subset of `recipeIds` that are ACTIVE same-org recipes,
 * in id-ascending order (deadlock-free, same discipline as productions).
 */
async function lockActiveRecipeSubset(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<string[]> {
  if (recipeIds.length === 0) return [];
  const locked = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        inArray(recipes.id, recipeIds),
        isNull(recipes.deletedAt),
      ),
    )
    .orderBy(asc(recipes.id))
    .for('update');
  return locked.map((r) => r.id);
}

/**
 * Bulk-adds recipes to a book (library multi-select). Ineligible recipes are
 * skipped and reported, existing memberships are no-ops; a bad book id raises
 * the composite-FK violation. `recipeIds` must be distinct.
 */
export async function addRecipesToBook(
  db: TenantClient,
  organizationId: string,
  bookId: string,
  recipeIds: string[],
): Promise<BulkBookResult> {
  const affectedIds = await lockActiveRecipeSubset(db, organizationId, recipeIds);
  if (affectedIds.length > 0) {
    await db
      .insert(recipeBookEntries)
      .values(
        affectedIds.map((recipeId) => ({
          organizationId,
          recipeBookId: bookId,
          recipeId,
        })),
      )
      .onConflictDoNothing({
        target: [
          recipeBookEntries.organizationId,
          recipeBookEntries.recipeBookId,
          recipeBookEntries.recipeId,
        ],
      });
  }
  const affected = new Set(affectedIds);
  return {
    affectedIds,
    skippedIds: recipeIds.filter((id) => !affected.has(id)),
  };
}

/**
 * Bulk-removes recipes from a book. Same eligibility contract as
 * {@link addRecipesToBook}; removing a recipe that was not in the book is a
 * no-op, not an error.
 */
export async function removeRecipesFromBook(
  db: TenantClient,
  organizationId: string,
  bookId: string,
  recipeIds: string[],
): Promise<BulkBookResult> {
  const affectedIds = await lockActiveRecipeSubset(db, organizationId, recipeIds);
  if (affectedIds.length > 0) {
    await db
      .delete(recipeBookEntries)
      .where(
        and(
          eq(recipeBookEntries.organizationId, organizationId),
          eq(recipeBookEntries.recipeBookId, bookId),
          inArray(recipeBookEntries.recipeId, affectedIds),
        ),
      );
  }
  const affected = new Set(affectedIds);
  return {
    affectedIds,
    skippedIds: recipeIds.filter((id) => !affected.has(id)),
  };
}

/**
 * D2 coexistence write-through: mirrors a legacy folder move onto the
 * HOMONYMOUS books, so the two organizers stay in parity during Fase 7.
 * Given the recipe's old and new folder NAMES (the shared unique key the
 * backfill also uses):
 * - drops the membership in the book named after the OLD folder (a move, not
 *   an accumulation — other, hand-assigned books are never touched);
 * - ensures a book named after the NEW folder exists (created with the
 *   folder's icon at the end of the rail, same as the backfill would) and adds
 *   the membership.
 * Runs in the caller's `withOrg` transaction, after the folder move itself.
 */
export async function syncBookMembershipForFolderMove(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  oldFolder: { name: string } | null,
  newFolder: { name: string; icon: string | null } | null,
): Promise<void> {
  if (oldFolder && oldFolder.name !== newFolder?.name) {
    const [oldBook] = await db
      .select({ id: recipeBooks.id })
      .from(recipeBooks)
      .where(
        and(
          eq(recipeBooks.organizationId, organizationId),
          eq(recipeBooks.name, oldFolder.name),
        ),
      )
      .limit(1);
    if (oldBook) {
      await db
        .delete(recipeBookEntries)
        .where(
          and(
            eq(recipeBookEntries.organizationId, organizationId),
            eq(recipeBookEntries.recipeBookId, oldBook.id),
            eq(recipeBookEntries.recipeId, recipeId),
          ),
        );
    }
  }

  if (newFolder) {
    let [book] = await db
      .select({ id: recipeBooks.id })
      .from(recipeBooks)
      .where(
        and(
          eq(recipeBooks.organizationId, organizationId),
          eq(recipeBooks.name, newFolder.name),
        ),
      )
      .limit(1);
    if (!book) {
      book = { id: (await createBook(db, organizationId, newFolder.name, newFolder.icon)).id };
    }
    await db
      .insert(recipeBookEntries)
      .values({ organizationId, recipeBookId: book.id, recipeId })
      .onConflictDoNothing({
        target: [
          recipeBookEntries.organizationId,
          recipeBookEntries.recipeBookId,
          recipeBookEntries.recipeId,
        ],
      });
  }
}
