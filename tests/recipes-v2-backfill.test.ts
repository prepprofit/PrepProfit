import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  recipes,
  recipeFolders,
  recipeBooks,
  recipeBookEntries,
  recipePortionOptions,
} from '@/lib/db/schema';
import { backfillRecipesV2ForOrg } from '@/lib/data/recipes-v2-backfill';

const ORG_A = 'org_bfa';
const ORG_B = 'org_bfb';

let client: PGlite;
let db: TenantDb;
let folderAId: string;
let recipeInFolderId: string;
let recipeLooseId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const [folderA] = await db
    .insert(recipeFolders)
    .values({ organizationId: ORG_A, name: 'Desserts', icon: '🍰', sortOrder: 2 })
    .returning();
  folderAId = folderA!.id;

  const inserted = await db
    .insert(recipes)
    .values([
      {
        organizationId: ORG_A,
        name: 'Cheesecake',
        folderId: folderAId,
        yieldPortions: 12,
        sellingPriceCents: 850,
      },
      {
        organizationId: ORG_A,
        name: 'Stock',
        yieldPortions: 4,
        sellingPriceCents: null,
      },
      { organizationId: ORG_B, name: 'Other org recipe', yieldPortions: 2 },
    ])
    .returning();
  recipeInFolderId = inserted[0]!.id;
  recipeLooseId = inserted[1]!.id;
});

afterAll(async () => {
  await client.close();
});

describe('backfillRecipesV2ForOrg', () => {
  it('creates books, memberships, yields and default portion options', async () => {
    const stats = await runInOrg(db, ORG_A, (tx) =>
      backfillRecipesV2ForOrg(tx, ORG_A),
    );
    expect(stats).toEqual({
      booksCreated: 1,
      membershipsCreated: 1,
      yieldsBackfilled: 2,
      portionOptionsCreated: 2,
    });

    const [book] = await db
      .select()
      .from(recipeBooks)
      .where(eq(recipeBooks.organizationId, ORG_A));
    expect(book!.name).toBe('Desserts');
    expect(book!.icon).toBe('🍰');
    expect(book!.sortOrder).toBe(2);

    const entries = await db
      .select()
      .from(recipeBookEntries)
      .where(eq(recipeBookEntries.organizationId, ORG_A));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.recipeId).toBe(recipeInFolderId);
    expect(entries[0]!.recipeBookId).toBe(book!.id);

    const [filed] = await db
      .select()
      .from(recipes)
      .where(and(eq(recipes.organizationId, ORG_A), eq(recipes.id, recipeInFolderId)));
    if (!filed) throw new Error("filed recipe not found");
    expect(filed.yieldQuantity).toBe(12);
    expect(filed.yieldUnit).toBe('serving');
    // Legacy fields untouched (Release A never mutates the old editor's data).
    expect(filed.folderId).toBe(folderAId);
    expect(filed.sellingPriceCents).toBe(850);

    const options = await db
      .select()
      .from(recipePortionOptions)
      .where(eq(recipePortionOptions.organizationId, ORG_A));
    expect(options).toHaveLength(2);
    const filedOption = options.find((o) => o.recipeId === recipeInFolderId)!;
    expect(filedOption.name).toBe('Default serving');
    expect(filedOption.quantity).toBe(1);
    expect(filedOption.unit).toBe('serving');
    expect(filedOption.isDefault).toBe(true);
    expect(filedOption.sellingPriceCents).toBe(850);
    // Priceless recipe: option exists, price honestly NULL (never 0).
    const looseOption = options.find((o) => o.recipeId === recipeLooseId)!;
    expect(looseOption.sellingPriceCents).toBeNull();
  });

  it('is idempotent — a re-run creates nothing new', async () => {
    const stats = await runInOrg(db, ORG_A, (tx) =>
      backfillRecipesV2ForOrg(tx, ORG_A),
    );
    expect(stats).toEqual({
      booksCreated: 0,
      membershipsCreated: 0,
      yieldsBackfilled: 0,
      portionOptionsCreated: 0,
    });
  });

  it('never overwrites a hand-edited yield or existing portion option', async () => {
    await db
      .update(recipes)
      .set({ yieldQuantity: 3, yieldUnit: 'qt' })
      .where(and(eq(recipes.organizationId, ORG_A), eq(recipes.id, recipeLooseId)));

    await runInOrg(db, ORG_A, (tx) => backfillRecipesV2ForOrg(tx, ORG_A));

    const [loose] = await db
      .select()
      .from(recipes)
      .where(and(eq(recipes.organizationId, ORG_A), eq(recipes.id, recipeLooseId)));
    if (!loose) throw new Error("loose recipe not found");
    expect(loose.yieldQuantity).toBe(3);
    expect(loose.yieldUnit).toBe('qt');

    const options = await db
      .select()
      .from(recipePortionOptions)
      .where(
        and(
          eq(recipePortionOptions.organizationId, ORG_A),
          eq(recipePortionOptions.recipeId, recipeLooseId),
        ),
      );
    expect(options).toHaveLength(1);
  });

  it('is org-scoped — nothing leaks into or out of org B', async () => {
    const books = await db
      .select()
      .from(recipeBooks)
      .where(eq(recipeBooks.organizationId, ORG_B));
    expect(books).toHaveLength(0);

    const statsB = await runInOrg(db, ORG_B, (tx) =>
      backfillRecipesV2ForOrg(tx, ORG_B),
    );
    expect(statsB.booksCreated).toBe(0); // org B has no folders
    expect(statsB.yieldsBackfilled).toBe(1);
    expect(statsB.portionOptionsCreated).toBe(1);
  });

  it('RLS isolates the new tables (tenant role sees only its org)', async () => {
    await runInOrg(db, ORG_B, async (tx) => {
      await tx.execute(sql.raw('SET ROLE tenant_app;'));
      const books = await tx.select().from(recipeBooks);
      const entries = await tx.select().from(recipeBookEntries);
      const options = await tx.select().from(recipePortionOptions);
      await tx.execute(sql.raw('RESET ROLE;'));
      expect(books).toHaveLength(0);
      expect(entries).toHaveLength(0);
      expect(options.every((o) => o.organizationId === ORG_B)).toBe(true);
      expect(options).toHaveLength(1);
    });
  });
});
