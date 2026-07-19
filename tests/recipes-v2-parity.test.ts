import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { recipes, recipeFolders, recipePortionOptions } from '@/lib/db/schema';
import {
  checkRecipesV2Parity,
  parityReportIsClean,
} from '@/lib/data/recipes-v2-parity';
import { backfillRecipesV2ForOrg } from '@/lib/data/recipes-v2-backfill';
import { createRecipe } from '@/lib/data/recipes';

const ORG = 'org_parity';
const OTHER = 'org_parity_other';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

describe('checkRecipesV2Parity', () => {
  it('flags each divergence bucket with ids, org-scoped', async () => {
    // 1. Legacy-shaped recipe with NO default option (raw insert, like pre-v2).
    const [legacy] = await db
      .insert(recipes)
      .values({ organizationId: ORG, name: 'Legacy', sellingPriceCents: 300 })
      .returning();

    // 2. Recipe whose default option lost its price while legacy still has one.
    const behind = await createRecipe(db, ORG, {
      name: 'Behind',
      sellingPriceCents: 400,
    });
    await db
      .update(recipePortionOptions)
      .set({ sellingPriceCents: null })
      .where(
        and(
          eq(recipePortionOptions.organizationId, ORG),
          eq(recipePortionOptions.recipeId, behind.id),
        ),
      );

    // 3. Folder with no homonymous book.
    const [folder] = await db
      .insert(recipeFolders)
      .values({ organizationId: ORG, name: 'Orphan folder' })
      .returning();

    // Cross-org noise that must never leak into ORG's report.
    await db
      .insert(recipes)
      .values({ organizationId: OTHER, name: 'Other legacy' });

    const report = await checkRecipesV2Parity(db, ORG);
    expect(report.recipesWithoutDefaultOption).toEqual([legacy!.id]);
    expect(report.optionPriceBehindLegacy).toEqual([behind.id]);
    expect(report.foldersWithoutBook).toEqual([folder!.id]);
    expect(parityReportIsClean(report)).toBe(false);
  });

  it('is clean after the idempotent backfill fixes buckets 1 and 3', async () => {
    await backfillRecipesV2ForOrg(db, ORG);
    // Bucket 2 needs a human decision — resolve it here to prove the clean path.
    await db
      .update(recipePortionOptions)
      .set({ sellingPriceCents: 400 })
      .where(eq(recipePortionOptions.organizationId, ORG));

    const report = await checkRecipesV2Parity(db, ORG);
    expect(report.recipesWithoutDefaultOption).toEqual([]);
    expect(report.foldersWithoutBook).toEqual([]);
    expect(report.optionPriceBehindLegacy).toEqual([]);
    expect(parityReportIsClean(report)).toBe(true);
  });
});
