import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { recipeFolders as recipeFoldersTable } from '@/lib/db/schema';
import {
  createFolder,
  deleteFolder,
  listFolders,
  listFoldersWithCounts,
  updateFolder,
  reorderFolder,
} from '@/lib/data/recipe-folders';
import {
  createRecipe,
  listRecipes,
  moveRecipeToFolder,
  restoreRecipe,
  softDeleteRecipe,
} from '@/lib/data/recipes';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

const folderNames = (rows: { name: string }[]) => rows.map((f) => f.name);

describe('recipe folders data layer', () => {
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

  it('creates folders scoped to an org; another org sees none', async () => {
    await createFolder(db, ORG_A, 'Breads');
    await createFolder(db, ORG_A, 'Pastries');

    expect(folderNames(await listFolders(db, ORG_A))).toEqual([
      'Breads',
      'Pastries',
    ]);
    expect(await listFolders(db, ORG_B)).toHaveLength(0);
  });

  it('rejects a duplicate folder name in the same org (create and rename)', async () => {
    await createFolder(db, ORG_A, 'Breads');
    await expect(createFolder(db, ORG_A, 'Breads')).rejects.toThrow();

    // Same name is fine in a different org (org-scoped uniqueness).
    await expect(createFolder(db, ORG_B, 'Breads')).resolves.toBeTruthy();

    const pastries = await createFolder(db, ORG_A, 'Pastries');
    await expect(
      updateFolder(db, ORG_A, pastries.id, 'Breads'),
    ).rejects.toThrow();
  });

  it('round-trips a folder icon on create, update, and listing', async () => {
    const breads = await createFolder(db, ORG_A, 'Breads', '🍞');
    expect(breads.icon).toBe('🍞');

    // The icon surfaces in the rail listing shape.
    const listing = await listFoldersWithCounts(db, ORG_A);
    expect(listing.folders[0]?.icon).toBe('🍞');

    // Update can change the icon...
    const updated = await updateFolder(db, ORG_A, breads.id, 'Breads', '🥐');
    expect(updated?.icon).toBe('🥐');

    // ...and clear it back to the default (null) glyph.
    const cleared = await updateFolder(db, ORG_A, breads.id, 'Breads', null);
    expect(cleared?.icon).toBeNull();

    // A folder created without an icon defaults to null.
    const plain = await createFolder(db, ORG_A, 'Pastries');
    expect(plain.icon).toBeNull();
  });

  it('reorders folders by swapping with the neighbour, and no-ops at the ends', async () => {
    await createFolder(db, ORG_A, 'A');
    await createFolder(db, ORG_A, 'B');
    await createFolder(db, ORG_A, 'C');
    const idOf = async (name: string) =>
      (await listFolders(db, ORG_A)).find((f) => f.name === name)!.id;

    expect(await reorderFolder(db, ORG_A, await idOf('A'), 'down')).toBe(true);
    expect(folderNames(await listFolders(db, ORG_A))).toEqual(['B', 'A', 'C']);

    expect(await reorderFolder(db, ORG_A, await idOf('C'), 'up')).toBe(true);
    expect(folderNames(await listFolders(db, ORG_A))).toEqual(['B', 'C', 'A']);

    // 'B' is already first — moving up is a no-op.
    expect(await reorderFolder(db, ORG_A, await idOf('B'), 'up')).toBe(false);
    expect(folderNames(await listFolders(db, ORG_A))).toEqual(['B', 'C', 'A']);
  });

  it('counts active recipes per folder, plus uncategorized and total', async () => {
    const breads = await createFolder(db, ORG_A, 'Breads');
    const pastries = await createFolder(db, ORG_A, 'Pastries');
    await createRecipe(db, ORG_A, { name: 'Sourdough', folderId: breads.id });
    await createRecipe(db, ORG_A, { name: 'Baguette', folderId: breads.id });
    await createRecipe(db, ORG_A, { name: 'Croissant', folderId: pastries.id });
    await createRecipe(db, ORG_A, { name: 'Loose recipe' }); // uncategorized

    const listing = await listFoldersWithCounts(db, ORG_A);
    expect(listing.totalCount).toBe(4);
    expect(listing.uncategorizedCount).toBe(1);
    expect(
      listing.folders.map((f) => ({ name: f.name, count: f.recipeCount })),
    ).toEqual([
      { name: 'Breads', count: 2 },
      { name: 'Pastries', count: 1 },
    ]);
  });

  it('excludes trashed recipes from folder counts and folder listings', async () => {
    const breads = await createFolder(db, ORG_A, 'Breads');
    const sourdough = await createRecipe(db, ORG_A, {
      name: 'Sourdough',
      folderId: breads.id,
    });
    await createRecipe(db, ORG_A, { name: 'Baguette', folderId: breads.id });

    await softDeleteRecipe(db, ORG_A, sourdough.id);

    const listing = await listFoldersWithCounts(db, ORG_A);
    expect(listing.totalCount).toBe(1);
    expect(listing.folders[0]?.recipeCount).toBe(1);
    expect(
      (await listRecipes(db, ORG_A, { kind: 'folder', folderId: breads.id })).map(
        (r) => r.name,
      ),
    ).toEqual(['Baguette']); // trashed Sourdough is gone

    // Restoring brings it back into the same folder.
    await restoreRecipe(db, ORG_A, sourdough.id);
    expect((await listFoldersWithCounts(db, ORG_A)).folders[0]?.recipeCount).toBe(
      2,
    );
  });

  it('moves a recipe between folders and to "No folder"', async () => {
    const breads = await createFolder(db, ORG_A, 'Breads');
    const pastries = await createFolder(db, ORG_A, 'Pastries');
    const recipe = await createRecipe(db, ORG_A, { name: 'Brioche' }); // uncategorized

    await moveRecipeToFolder(db, ORG_A, recipe.id, breads.id);
    expect(
      (await listRecipes(db, ORG_A, { kind: 'folder', folderId: breads.id })).map(
        (r) => r.name,
      ),
    ).toEqual(['Brioche']);

    await moveRecipeToFolder(db, ORG_A, recipe.id, pastries.id);
    expect(
      await listRecipes(db, ORG_A, { kind: 'folder', folderId: breads.id }),
    ).toHaveLength(0);

    await moveRecipeToFolder(db, ORG_A, recipe.id, null);
    expect(
      (await listRecipes(db, ORG_A, { kind: 'uncategorized' })).map((r) => r.name),
    ).toEqual(['Brioche']);
  });

  it('deleting a folder re-files its recipes to "No folder" and leaves others intact', async () => {
    const breads = await createFolder(db, ORG_A, 'Breads');
    const pastries = await createFolder(db, ORG_A, 'Pastries');
    const sourdough = await createRecipe(db, ORG_A, {
      name: 'Sourdough',
      folderId: breads.id,
    });
    await createRecipe(db, ORG_A, { name: 'Croissant', folderId: pastries.id });

    expect(await deleteFolder(db, ORG_A, breads.id)).toBe(true);

    // Folder gone, the other folder untouched.
    expect(folderNames(await listFolders(db, ORG_A))).toEqual(['Pastries']);
    // Its recipe is now uncategorized, not trashed.
    const moved = (await listRecipes(db, ORG_A, { kind: 'all' })).find(
      (r) => r.id === sourdough.id,
    );
    expect(moved?.folderId).toBeNull();
    expect(
      (await listRecipes(db, ORG_A, { kind: 'uncategorized' })).map((r) => r.name),
    ).toEqual(['Sourdough']);
  });

  it('deleting a folder works even when a trashed recipe was filed under it', async () => {
    const breads = await createFolder(db, ORG_A, 'Breads');
    const sourdough = await createRecipe(db, ORG_A, {
      name: 'Sourdough',
      folderId: breads.id,
    });
    await softDeleteRecipe(db, ORG_A, sourdough.id);

    // The restrict FK would block the delete if the trashed recipe still pinned
    // the folder; deleteFolder nulls ALL referencing rows first.
    expect(await deleteFolder(db, ORG_A, breads.id)).toBe(true);
    expect(await listFolders(db, ORG_A)).toHaveLength(0);
  });

  it('keeps folders org-isolated under RLS', async () => {
    await createFolder(db, ORG_A, 'Breads');
    await createFolder(db, ORG_B, 'Cakes');

    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const visible = await runInOrg(db, ORG_A, async (tx) =>
        tx
          .select({ org: recipeFoldersTable.organizationId })
          .from(recipeFoldersTable), // unfiltered — RLS must scope it
      );
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((r) => r.org === ORG_A)).toBe(true);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});
