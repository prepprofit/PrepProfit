import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  recipeBooks as recipeBooksTable,
  recipeBookEntries as recipeBookEntriesTable,
} from '@/lib/db/schema';
import {
  addRecipesToBook,
  createBook,
  deleteBook,
  listBooks,
  listBooksWithCounts,
  loadBookIdsByRecipe,
  removeRecipesFromBook,
  reorderBook,
  setRecipeBooks,
  updateBook,
} from '@/lib/data/recipe-books';
import { createFolder } from '@/lib/data/recipe-folders';
import {
  createRecipe,
  moveRecipeToFolder,
  softDeleteRecipe,
  updateRecipe,
} from '@/lib/data/recipes';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

const bookNames = (rows: { name: string }[]) => rows.map((b) => b.name);

describe('recipe books data layer', () => {
  let client: PGlite;
  let db: TenantDb;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db as unknown as TenantDb;
  });

  afterEach(async () => {
    await client.close();
  });

  const entriesOf = async (organizationId: string) =>
    db
      .select()
      .from(recipeBookEntriesTable)
      .where(eq(recipeBookEntriesTable.organizationId, organizationId));

  it('creates, renames, reorders and deletes books scoped to an org', async () => {
    const brunch = await createBook(db, ORG_A, 'Brunch', '🥞');
    await createBook(db, ORG_A, 'Dinner');
    expect(bookNames(await listBooks(db, ORG_A))).toEqual(['Brunch', 'Dinner']);
    expect(await listBooks(db, ORG_B)).toHaveLength(0);

    // Duplicate name in the same org rejects; other org is fine.
    await expect(createBook(db, ORG_A, 'Brunch')).rejects.toThrow();
    await expect(createBook(db, ORG_B, 'Brunch')).resolves.toBeTruthy();

    const renamed = await updateBook(db, ORG_A, brunch.id, 'Breakfast', null);
    expect(renamed?.name).toBe('Breakfast');
    expect(renamed?.icon).toBeNull();

    expect(await reorderBook(db, ORG_A, brunch.id, 'down')).toBe(true);
    expect(bookNames(await listBooks(db, ORG_A))).toEqual([
      'Dinner',
      'Breakfast',
    ]);
    // Already last — no-op.
    expect(await reorderBook(db, ORG_A, brunch.id, 'down')).toBe(false);

    expect(await deleteBook(db, ORG_A, brunch.id)).toBe(true);
    expect(bookNames(await listBooks(db, ORG_A))).toEqual(['Dinner']);
    expect(await deleteBook(db, ORG_A, brunch.id)).toBe(false);
  });

  it('counts only ACTIVE recipes per book; entries cascade on book delete', async () => {
    const book = await createBook(db, ORG_A, 'Brunch');
    const pancakes = await createRecipe(db, ORG_A, { name: 'Pancakes' });
    const waffles = await createRecipe(db, ORG_A, { name: 'Waffles' });
    await setRecipeBooks(db, ORG_A, pancakes.id, [book.id]);
    await setRecipeBooks(db, ORG_A, waffles.id, [book.id]);

    expect((await listBooksWithCounts(db, ORG_A))[0]?.recipeCount).toBe(2);

    // Trashed recipe keeps its membership but leaves the count.
    await softDeleteRecipe(db, ORG_A, waffles.id);
    expect((await listBooksWithCounts(db, ORG_A))[0]?.recipeCount).toBe(1);
    expect(await entriesOf(ORG_A)).toHaveLength(2);

    await deleteBook(db, ORG_A, book.id);
    expect(await entriesOf(ORG_A)).toHaveLength(0);
  });

  it('setRecipeBooks replaces memberships atomically and rejects bad targets', async () => {
    const brunch = await createBook(db, ORG_A, 'Brunch');
    const dinner = await createBook(db, ORG_A, 'Dinner');
    const recipe = await createRecipe(db, ORG_A, { name: 'Pancakes' });

    expect(await setRecipeBooks(db, ORG_A, recipe.id, [brunch.id])).toBe(true);
    expect(await setRecipeBooks(db, ORG_A, recipe.id, [dinner.id])).toBe(true);
    const entries = await entriesOf(ORG_A);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.recipeBookId).toBe(dinner.id);

    // Empty list clears all memberships.
    expect(await setRecipeBooks(db, ORG_A, recipe.id, [])).toBe(true);
    expect(await entriesOf(ORG_A)).toHaveLength(0);

    // Trashed recipe: no writes, reported.
    await softDeleteRecipe(db, ORG_A, recipe.id);
    expect(await setRecipeBooks(db, ORG_A, recipe.id, [brunch.id])).toBe(false);
    expect(await entriesOf(ORG_A)).toHaveLength(0);

    // Cross-org book id: composite FK violation surfaces.
    const other = await createRecipe(db, ORG_A, { name: 'Waffles' });
    const foreign = await createBook(db, ORG_B, 'Theirs');
    await expect(
      setRecipeBooks(db, ORG_A, other.id, [foreign.id]),
    ).rejects.toThrow();
  });

  it('bulk add/remove writes eligible recipes and reports skipped ones', async () => {
    const book = await createBook(db, ORG_A, 'Brunch');
    const pancakes = await createRecipe(db, ORG_A, { name: 'Pancakes' });
    const waffles = await createRecipe(db, ORG_A, { name: 'Waffles' });
    const trashed = await createRecipe(db, ORG_A, { name: 'Old' });
    await softDeleteRecipe(db, ORG_A, trashed.id);
    const foreign = await createRecipe(db, ORG_B, { name: 'Theirs' });

    const added = await addRecipesToBook(db, ORG_A, book.id, [
      pancakes.id,
      waffles.id,
      trashed.id,
      foreign.id,
      'missing',
    ]);
    expect(new Set(added.affectedIds)).toEqual(
      new Set([pancakes.id, waffles.id]),
    );
    expect(new Set(added.skippedIds)).toEqual(
      new Set([trashed.id, foreign.id, 'missing']),
    );
    expect(await entriesOf(ORG_A)).toHaveLength(2);
    expect(await entriesOf(ORG_B)).toHaveLength(0);

    // Re-adding is a no-op, not an error.
    await addRecipesToBook(db, ORG_A, book.id, [pancakes.id]);
    expect(await entriesOf(ORG_A)).toHaveLength(2);

    const removed = await removeRecipesFromBook(db, ORG_A, book.id, [
      pancakes.id,
      trashed.id,
    ]);
    expect(removed.affectedIds).toEqual([pancakes.id]);
    expect(removed.skippedIds).toEqual([trashed.id]);
    expect((await entriesOf(ORG_A)).map((e) => e.recipeId)).toEqual([
      waffles.id,
    ]);
  });

  it('loadBookIdsByRecipe maps memberships for the requested recipes only', async () => {
    const brunch = await createBook(db, ORG_A, 'Brunch');
    const dinner = await createBook(db, ORG_A, 'Dinner');
    const pancakes = await createRecipe(db, ORG_A, { name: 'Pancakes' });
    const stew = await createRecipe(db, ORG_A, { name: 'Stew' });
    await setRecipeBooks(db, ORG_A, pancakes.id, [brunch.id, dinner.id]);
    await setRecipeBooks(db, ORG_A, stew.id, [dinner.id]);

    const map = await loadBookIdsByRecipe(db, ORG_A, [pancakes.id]);
    expect(new Set(map.get(pancakes.id))).toEqual(
      new Set([brunch.id, dinner.id]),
    );
    expect(map.has(stew.id)).toBe(false);
    expect(await loadBookIdsByRecipe(db, ORG_A, [])).toEqual(new Map());
  });

  describe('folder → book write-through (D2 coexistence)', () => {
    it('mirrors a folder move onto the homonymous book, creating it if missing', async () => {
      const breads = await createFolder(db, ORG_A, 'Breads', '🍞');
      const recipe = await createRecipe(db, ORG_A, { name: 'Sourdough' });

      await moveRecipeToFolder(db, ORG_A, recipe.id, breads.id);

      const books = await listBooks(db, ORG_A);
      expect(bookNames(books)).toEqual(['Breads']);
      expect(books[0]!.icon).toBe('🍞');
      expect((await entriesOf(ORG_A)).map((e) => e.recipeId)).toEqual([
        recipe.id,
      ]);
    });

    it('moves the membership between homonymous books and clears it on "No folder"', async () => {
      const breads = await createFolder(db, ORG_A, 'Breads');
      const pastries = await createFolder(db, ORG_A, 'Pastries');
      // A hand-assigned book must never be touched by the mirror.
      const favourites = await createBook(db, ORG_A, 'Favourites');
      const recipe = await createRecipe(db, ORG_A, { name: 'Brioche' });
      await addRecipesToBook(db, ORG_A, favourites.id, [recipe.id]);

      await moveRecipeToFolder(db, ORG_A, recipe.id, breads.id);
      await moveRecipeToFolder(db, ORG_A, recipe.id, pastries.id);

      const pastriesBook = (await listBooks(db, ORG_A)).find(
        (b) => b.name === 'Pastries',
      )!;
      let bookIds = (await entriesOf(ORG_A)).map((e) => e.recipeBookId);
      expect(new Set(bookIds)).toEqual(
        new Set([favourites.id, pastriesBook.id]),
      );

      await moveRecipeToFolder(db, ORG_A, recipe.id, null);
      bookIds = (await entriesOf(ORG_A)).map((e) => e.recipeBookId);
      expect(bookIds).toEqual([favourites.id]);
    });

    it('mirrors createRecipe-with-folder and a folder change through updateRecipe', async () => {
      const breads = await createFolder(db, ORG_A, 'Breads');
      const pastries = await createFolder(db, ORG_A, 'Pastries');

      const recipe = await createRecipe(db, ORG_A, {
        name: 'Sourdough',
        folderId: breads.id,
      });
      const breadsBook = (await listBooks(db, ORG_A)).find(
        (b) => b.name === 'Breads',
      )!;
      expect((await entriesOf(ORG_A)).map((e) => e.recipeBookId)).toEqual([
        breadsBook.id,
      ]);

      await updateRecipe(db, ORG_A, recipe.id, {
        name: 'Sourdough',
        folderId: pastries.id,
      });
      const pastriesBook = (await listBooks(db, ORG_A)).find(
        (b) => b.name === 'Pastries',
      )!;
      expect((await entriesOf(ORG_A)).map((e) => e.recipeBookId)).toEqual([
        pastriesBook.id,
      ]);
    });
  });

  describe('RLS', () => {
    it('SELECT: tenant role sees only its org for books and entries', async () => {
      const bookA = await createBook(db, ORG_A, 'Mine');
      await createBook(db, ORG_B, 'Theirs');
      const recipe = await createRecipe(db, ORG_A, { name: 'Pancakes' });
      await setRecipeBooks(db, ORG_A, recipe.id, [bookA.id]);

      await db.execute(sql.raw('SET ROLE tenant_app;'));
      try {
        await runInOrg(db, ORG_A, async (tx) => {
          const books = await tx.select().from(recipeBooksTable);
          expect(books).toHaveLength(1);
          expect(books[0]!.organizationId).toBe(ORG_A);
          const entries = await tx.select().from(recipeBookEntriesTable);
          expect(entries.every((e) => e.organizationId === ORG_A)).toBe(true);
          expect(entries).toHaveLength(1);
        });
      } finally {
        await db.execute(sql.raw('RESET ROLE;'));
      }
    });

    it('INSERT/UPDATE/DELETE: WITH CHECK blocks cross-org writes and retags', async () => {
      const bookB = await createBook(db, ORG_B, 'Theirs');

      await db.execute(sql.raw('SET ROLE tenant_app;'));
      try {
        // Each statement gets its own transaction — a rejected write aborts
        // the whole transaction block, so they cannot share one runInOrg.
        // INSERT into another org is rejected by WITH CHECK.
        await expect(
          runInOrg(db, ORG_A, (tx) =>
            tx
              .insert(recipeBooksTable)
              .values({ organizationId: ORG_B, name: 'Smuggled' }),
          ),
        ).rejects.toThrow();

        // UPDATE cannot reach another org's row (USING matches none).
        const updated = await runInOrg(db, ORG_A, (tx) =>
          tx
            .update(recipeBooksTable)
            .set({ name: 'Hijacked' })
            .where(eq(recipeBooksTable.id, bookB.id))
            .returning(),
        );
        expect(updated).toHaveLength(0);

        // DELETE cannot reach another org's row.
        const deleted = await runInOrg(db, ORG_A, (tx) =>
          tx
            .delete(recipeBooksTable)
            .where(eq(recipeBooksTable.id, bookB.id))
            .returning(),
        );
        expect(deleted).toHaveLength(0);
      } finally {
        await db.execute(sql.raw('RESET ROLE;'));
      }

      // The row survived untouched.
      const [survivor] = await db
        .select()
        .from(recipeBooksTable)
        .where(
          and(
            eq(recipeBooksTable.organizationId, ORG_B),
            eq(recipeBooksTable.id, bookB.id),
          ),
        );
      expect(survivor?.name).toBe('Theirs');
    });
  });
});
