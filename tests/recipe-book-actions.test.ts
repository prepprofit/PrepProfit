import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { auditLog, recipeComponents, recipes } from '@/lib/db/schema';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { createBook } from '@/lib/data/recipe-books';

/**
 * Action-level tests for the library bulk actions (Fase 7 Slice 4): honest
 * partial results (trashed/blocked/skipped buckets), the sub-recipe in-use
 * guard, the bounded-input rejection, and the atomic `recipe.bulkTrash` audit
 * event inside the same transaction.
 */

const ORG = 'org_bulk';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_bulk',
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => 'manager'),
}));

vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    getDb: () => h.db,
    withOrg: (org: string, fn: (tx: never) => unknown) =>
      realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  addRecipesToBookAction,
  bulkTrashRecipesAction,
} from '@/app/(app)/recipes/book-actions';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  h.db = db;
});

afterAll(async () => {
  await client.close();
});

describe('bulkTrashRecipesAction', () => {
  it('trashes eligible recipes, blocks in-use components, reports skipped, audits', async () => {
    const loose = await createRecipe(db, ORG, { name: 'Loose' });
    const child = await createRecipe(db, ORG, {
      name: 'Child',
      yieldWeightGrams: 1000,
    });
    const parent = await createRecipe(db, ORG, { name: 'Parent' });
    await db.insert(recipeComponents).values({
      organizationId: ORG,
      recipeId: parent.id,
      componentRecipeId: child.id,
      quantityGrams: 250,
    });
    const gone = await createRecipe(db, ORG, { name: 'Already trashed' });
    await softDeleteRecipe(db, ORG, gone.id);

    const result = await bulkTrashRecipesAction({
      recipeIds: [loose.id, child.id, gone.id, 'missing'],
    });
    expect(result).toEqual({
      ok: true,
      data: { trashed: 1, blocked: 1, skipped: 2 },
    });

    const [looseRow] = await db
      .select()
      .from(recipes)
      .where(eq(recipes.id, loose.id));
    expect(looseRow!.deletedAt).not.toBeNull();
    const [childRow] = await db
      .select()
      .from(recipes)
      .where(eq(recipes.id, child.id));
    expect(childRow!.deletedAt).toBeNull(); // blocked — still active

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.organizationId, ORG));
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('recipe.bulkTrash');
    expect(events[0]!.metadata).toMatchObject({
      trashed: 1,
      blocked: 1,
      skipped: 2,
      trashedIds: [loose.id],
    });
  });

  it('rejects an unbounded selection (INVALID_INPUT before any work)', async () => {
    const result = await bulkTrashRecipesAction({
      recipeIds: Array.from({ length: 201 }, (_, i) => `id_${i}`),
    });
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('addRecipesToBookAction', () => {
  it('adds eligible recipes and reports the skipped ones', async () => {
    const book = await createBook(db, ORG, 'Bulk book');
    const a = await createRecipe(db, ORG, { name: 'A' });
    const b = await createRecipe(db, ORG, { name: 'B' });

    const result = await addRecipesToBookAction({
      bookId: book.id,
      recipeIds: [a.id, b.id, 'missing'],
    });
    expect(result).toEqual({ ok: true, data: { affected: 2, skipped: 1 } });
  });

  it('returns NOT_FOUND for a cross-org book id (composite FK)', async () => {
    const foreignBook = await createBook(db, 'org_other', 'Theirs');
    const a = await createRecipe(db, ORG, { name: 'C' });
    const result = await addRecipesToBookAction({
      bookId: foreignBook.id,
      recipeIds: [a.id],
    });
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});
