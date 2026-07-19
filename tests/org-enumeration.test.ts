import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { recipeFolders } from '@/lib/db/schema';
import { listRecipeOrgIds } from '@/lib/db/org-enumeration';
import { createRecipe } from '@/lib/data/recipes';

/**
 * `listRecipeOrgIds` must return EVERY org with recipe-domain data — the whole
 * point of the Fase 7 hardening (Clerk enumeration once missed a prod org).
 * The union covers orgs reachable via any of the three tables.
 */

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  // org_recipes: has a recipe (which auto-creates a portion option).
  await createRecipe(db, 'org_recipes', { name: 'Bread' });
  // org_folder_only: a folder but no recipe yet — must still be enumerated.
  await db
    .insert(recipeFolders)
    .values({ organizationId: 'org_folder_only', name: 'Empty folder' });
});

afterAll(async () => {
  await client.close();
});

describe('listRecipeOrgIds', () => {
  it('returns every distinct org across recipes, folders and portion options', async () => {
    const ids = await listRecipeOrgIds(db);
    expect(new Set(ids)).toEqual(new Set(['org_recipes', 'org_folder_only']));
    // Distinct — one recipe + its option must not double-count its org.
    expect(ids.length).toBe(new Set(ids).size);
  });
});
