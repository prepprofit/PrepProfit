import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import type { UserRole } from '@/lib/auth';
import { runSearch } from '@/lib/search/run';
import type { GroupedSearchResults } from '@/lib/search/types';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { createIngredient } from '@/lib/data/ingredients';
import { createTransaction } from '@/lib/data/transactions';
import {
  ensureCategoriesSeeded,
  listCategories,
} from '@/lib/data/transaction-categories';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

/** Flatten every result across groups (handy for cross-org leak assertions). */
function allResults(r: GroupedSearchResults) {
  return r.groups.flatMap((g) => g.results);
}
function groupTypes(r: GroupedSearchResults) {
  return r.groups.map((g) => g.type);
}

describe('global search (Sprint 2.7)', () => {
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

  const categoryId = async (org: string, slug: string) => {
    const cats = await listCategories(db, org);
    const found = cats.find((c) => c.slug === slug);
    if (!found) throw new Error(`seed: missing category ${slug}`);
    return found.id;
  };

  /**
   * Run a search the way production does: under the non-privileged `tenant_app`
   * role (so RLS is truly exercised) inside an org-scoped transaction.
   */
  const searchAs = async (
    org: string,
    role: UserRole,
    query: string,
  ): Promise<GroupedSearchResults> => {
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      return await runInOrg(db, org, (tx) => runSearch(tx, org, role, query));
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  };

  it('never returns another org\'s rows (isolation)', async () => {
    const aMousse = await createRecipe(db, ORG_A, { name: 'Chocolate Mousse' });
    const bGateau = await createRecipe(db, ORG_B, { name: 'Chocolate Gateau' });

    const result = await searchAs(ORG_A, 'manager', 'chocolate');
    const ids = allResults(result).map((r) => r.id);
    expect(ids).toContain(aMousse.id);
    expect(ids).not.toContain(bGateau.id);
    // And the href never points at org B's record.
    expect(allResults(result).every((r) => !r.href.includes(bGateau.id))).toBe(
      true,
    );
  });

  it('finds a misspelled recipe and ingredient name (trigram typo tolerance)', async () => {
    await createRecipe(db, ORG_A, { name: 'Chocolate Mousse' });
    await createIngredient(db, ORG_A, { name: 'Flour', dimension: 'weight' });

    const recipeHit = await searchAs(ORG_A, 'manager', 'chocolat mousse');
    expect(
      recipeHit.groups.find((g) => g.type === 'recipe')?.results[0]?.title,
    ).toBe('Chocolate Mousse');

    const ingredientHit = await searchAs(ORG_A, 'manager', 'fluor');
    expect(
      ingredientHit.groups.find((g) => g.type === 'ingredient')?.results[0]
        ?.title,
    ).toBe('Flour');
  });

  it('ranks results by relevance and groups them by entity', async () => {
    await createRecipe(db, ORG_A, { name: 'Tomato Soup' });
    await createRecipe(db, ORG_A, { name: 'Tomato Basil Tart' });
    await createIngredient(db, ORG_A, { name: 'Tomato', dimension: 'weight' });

    const result = await searchAs(ORG_A, 'manager', 'tomato');
    // Groups come back in registry order (recipe before ingredient).
    expect(groupTypes(result)).toEqual(['recipe', 'ingredient']);
    // The exact "Tomato" ingredient outranks the partial recipe matches.
    expect(
      result.groups.find((g) => g.type === 'ingredient')?.results[0]?.title,
    ).toBe('Tomato');
  });

  it('matches a transaction note for a manager but never for kitchen (RBAC)', async () => {
    await ensureCategoriesSeeded(db, ORG_A);
    const sales = await categoryId(ORG_A, 'food_sales');
    await createTransaction(db, ORG_A, {
      type: 'income',
      categoryId: sales,
      recipeId: null,
      occurredOn: '2026-06-10',
      amountCents: 25_000,
      note: 'Catering deposit for the Almeida wedding',
    });
    // Something a kitchen user IS allowed to find, to prove search still works.
    await createRecipe(db, ORG_A, { name: 'Catering platter' });

    const asManager = await searchAs(ORG_A, 'manager', 'catering');
    expect(groupTypes(asManager)).toContain('transaction');

    const asKitchen = await searchAs(ORG_A, 'kitchen', 'catering');
    expect(groupTypes(asKitchen)).not.toContain('transaction');
    // The kitchen user still gets the (non-financial) recipe match.
    expect(groupTypes(asKitchen)).toContain('recipe');
  });

  it('excludes soft-deleted records', async () => {
    const bread = await createRecipe(db, ORG_A, { name: 'Sourdough Bread' });
    await softDeleteRecipe(db, ORG_A, bread.id);

    const result = await searchAs(ORG_A, 'manager', 'sourdough');
    expect(allResults(result)).toHaveLength(0);
  });

  it('returns nothing for a too-short query (no DB round-trip needed)', async () => {
    await createRecipe(db, ORG_A, { name: 'Apple pie' });
    const result = await searchAs(ORG_A, 'manager', 'a');
    expect(result.groups).toHaveLength(0);
  });
});
