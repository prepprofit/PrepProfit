import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { recipes } from '@/lib/db/schema';
import { createRecipe, markRecipeOpened, softDeleteRecipe } from '@/lib/data/recipes';
import { createFolder } from '@/lib/data/recipe-folders';
import { listRecipesForLibrary } from '@/lib/data/recipe-library';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

describe('recipe recent activity', () => {
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

  async function recipeAt(name: string, created: string, updated: string, folderId: string | null = null) {
    const row = await createRecipe(db, ORG_A, { name, folderId });
    await db
      .update(recipes)
      .set({ createdAt: new Date(created), updatedAt: new Date(updated), lastOpenedAt: null })
      .where(eq(recipes.id, row.id));
    return row.id;
  }

  const order = async () => (await listRecipesForLibrary(db, ORG_A)).map((r) => r.name);

  it('orders by the latest edit or open, and opening never counts as an edit', async () => {
    const bases = await createFolder(db, ORG_A, 'Bases');
    const brioche = await recipeAt('Brioche', '2026-01-01', '2026-01-01', bases.id);
    await recipeAt('Custard', '2026-01-01', '2026-03-01', bases.id);
    await recipeAt('Apple tart', '2026-02-01', '2026-02-01');

    expect(await order()).toEqual(['Custard', 'Apple tart', 'Brioche']);

    await markRecipeOpened(db, ORG_A, brioche);
    expect(await order()).toEqual(['Brioche', 'Custard', 'Apple tart']);

    const [row] = await db.select().from(recipes).where(eq(recipes.id, brioche));
    expect(row?.updatedAt.toISOString()).toBe(new Date('2026-01-01').toISOString());
    expect(row?.lastOpenedAt).toBeInstanceOf(Date);

    // Folder filtering keeps the same order (the page filters these rows).
    const inBases = (await listRecipesForLibrary(db, ORG_A)).filter((r) => r.folderId === bases.id).map((r) => r.name);
    expect(inBases).toEqual(['Brioche', 'Custard']);
  });

  it('ignores trashed recipes and other organisations', async () => {
    const id = await recipeAt('Ganache', '2026-01-01', '2026-01-01');
    await markRecipeOpened(db, ORG_B, id);
    let [row] = await db.select().from(recipes).where(eq(recipes.id, id));
    expect(row?.lastOpenedAt).toBeNull();

    await softDeleteRecipe(db, ORG_A, id);
    await markRecipeOpened(db, ORG_A, id);
    [row] = await db.select().from(recipes).where(eq(recipes.id, id));
    expect(row?.lastOpenedAt).toBeNull();
  });
});
