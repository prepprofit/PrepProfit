import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  transactions as transactionsTable,
  transactionCategories as transactionCategoriesTable,
} from '@/lib/db/schema';
import { CATEGORY_SEED } from '@/lib/finance/categories';
import {
  createCustomCategory,
  deleteCustomCategory,
  ensureCategoriesSeeded,
  listCategories,
  renameCustomCategory,
} from '@/lib/data/transaction-categories';
import {
  createTransaction,
  listTransactions,
  listTrashedTransactions,
  purgeTransaction,
  restoreTransaction,
  softDeleteTransaction,
  type TransactionInput,
} from '@/lib/data/transactions';
import {
  createRecipe,
  purgeRecipe,
  softDeleteRecipe,
} from '@/lib/data/recipes';
import { purgeExpired } from '@/lib/data/trash';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

describe('financials data layer', () => {
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

  const income = (
    categoryId: string,
    occurredOn: string,
    amountCents: number,
    recipeId: string | null = null,
  ): TransactionInput => ({
    type: 'income',
    categoryId,
    recipeId,
    occurredOn,
    amountCents,
    note: null,
  });

  describe('categories', () => {
    it('seeds predefined categories idempotently, scoped per org', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      await ensureCategoriesSeeded(db, ORG_A); // second call must not duplicate

      const cats = await listCategories(db, ORG_A);
      expect(cats).toHaveLength(CATEGORY_SEED.length);
      expect(cats.every((c) => c.isSystem)).toBe(true);
      // Another org is untouched.
      expect(await listCategories(db, ORG_B)).toHaveLength(0);
    });

    it('filters categories by kind', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      const incomeCats = await listCategories(db, ORG_A, 'income');
      const expenseCats = await listCategories(db, ORG_A, 'expense');
      expect(incomeCats.every((c) => c.kind === 'income')).toBe(true);
      expect(expenseCats.every((c) => c.kind === 'expense')).toBe(true);
      expect(incomeCats.length + expenseCats.length).toBe(CATEGORY_SEED.length);
    });

    it('creates and renames a custom category; predefined stay locked', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      const custom = await createCustomCategory(db, ORG_A, 'Tips', 'income');
      expect(custom.slug).toBeNull();

      const renamed = await renameCustomCategory(db, ORG_A, custom.id, 'Gratuities');
      expect(renamed?.name).toBe('Gratuities');

      // A predefined row (slug set) cannot be renamed via the custom path.
      const foodSales = await categoryId(ORG_A, 'food_sales');
      expect(await renameCustomCategory(db, ORG_A, foodSales, 'Hacked')).toBeNull();
    });

    it('deletes an unused custom category but blocks one in use (RESTRICT FK)', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      const unused = await createCustomCategory(db, ORG_A, 'Unused', 'expense');
      expect(await deleteCustomCategory(db, ORG_A, unused.id)).toBe(true);

      const used = await createCustomCategory(db, ORG_A, 'Used', 'income');
      await createTransaction(db, ORG_A, income(used.id, '2026-06-01', 1_000));
      await expect(deleteCustomCategory(db, ORG_A, used.id)).rejects.toThrow();
    });
  });

  describe('transactions', () => {
    it('lists transactions org-scoped with period, type, and category filters', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      await ensureCategoriesSeeded(db, ORG_B);
      const aSales = await categoryId(ORG_A, 'food_sales');
      const aRent = await categoryId(ORG_A, 'rent');
      const bSales = await categoryId(ORG_B, 'food_sales');

      await createTransaction(db, ORG_A, income(aSales, '2026-05-10', 1_000));
      await createTransaction(db, ORG_A, income(aSales, '2026-06-10', 2_000));
      await createTransaction(db, ORG_A, {
        type: 'expense',
        categoryId: aRent,
        recipeId: null,
        occurredOn: '2026-06-15',
        amountCents: 3_000,
        note: null,
      });
      await createTransaction(db, ORG_B, income(bSales, '2026-06-10', 9_999));

      const all = await listTransactions(db, ORG_A);
      expect(all).toHaveLength(3);
      expect(all.some((t) => t.amountCents === 9_999)).toBe(false);

      const june = await listTransactions(db, ORG_A, {
        from: '2026-06-01',
        to: '2026-06-30',
      });
      expect(june).toHaveLength(2);

      const expenses = await listTransactions(db, ORG_A, { type: 'expense' });
      expect(expenses.map((t) => t.amountCents)).toEqual([3_000]);

      const rentOnly = await listTransactions(db, ORG_A, { categoryId: aRent });
      expect(rentOnly).toHaveLength(1);
    });

    it('rejects a transaction that links a category or recipe from another org', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      await ensureCategoriesSeeded(db, ORG_B);
      const bSales = await categoryId(ORG_B, 'food_sales');

      // org A row pointing at org B's category → composite FK has no parent.
      await expect(
        createTransaction(db, ORG_A, income(bSales, '2026-06-01', 1_000)),
      ).rejects.toThrow();

      const aSales = await categoryId(ORG_A, 'food_sales');
      const bRecipe = await createRecipe(db, ORG_B, { name: 'Cake B' });
      await expect(
        createTransaction(db, ORG_A, income(aSales, '2026-06-01', 1_000, bRecipe.id)),
      ).rejects.toThrow();
    });

    it('soft-deletes, restores, and purges a transaction', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      const aSales = await categoryId(ORG_A, 'food_sales');
      const txn = await createTransaction(db, ORG_A, income(aSales, '2026-06-01', 1_000));

      expect(await softDeleteTransaction(db, ORG_A, txn.id)).not.toBeNull();
      expect(await listTransactions(db, ORG_A)).toHaveLength(0);
      expect(await listTrashedTransactions(db, ORG_A)).toHaveLength(1);

      expect(await restoreTransaction(db, ORG_A, txn.id)).not.toBeNull();
      expect(await listTransactions(db, ORG_A)).toHaveLength(1);

      await softDeleteTransaction(db, ORG_A, txn.id);
      await purgeTransaction(db, ORG_A, txn.id);
      expect(await listTrashedTransactions(db, ORG_A)).toHaveLength(0);
    });

    it('purging a linked recipe unlinks its transactions instead of blocking', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      const aSales = await categoryId(ORG_A, 'food_sales');
      const recipe = await createRecipe(db, ORG_A, { name: 'Cake' });
      await createTransaction(db, ORG_A, income(aSales, '2026-06-01', 5_000, recipe.id));

      // The transaction shows the recipe name while it is active.
      expect((await listTransactions(db, ORG_A))[0]?.recipe?.name).toBe('Cake');

      await softDeleteRecipe(db, ORG_A, recipe.id);
      // The recipe FK is ON DELETE restrict — purge must unlink first, not throw.
      await expect(purgeRecipe(db, ORG_A, recipe.id)).resolves.toBeUndefined();

      const list = await listTransactions(db, ORG_A);
      expect(list).toHaveLength(1);
      expect(list[0]?.recipe).toBeNull(); // unlinked, record survives
      expect(list[0]?.amountCents).toBe(5_000);
    });

    it('auto-purge unlinks recipe links and removes expired trashed transactions', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      const aSales = await categoryId(ORG_A, 'food_sales');
      const recipe = await createRecipe(db, ORG_A, { name: 'Cake' });
      await createTransaction(db, ORG_A, income(aSales, '2026-06-01', 5_000, recipe.id));
      const trashed = await createTransaction(db, ORG_A, income(aSales, '2026-06-02', 1_000));
      await softDeleteTransaction(db, ORG_A, trashed.id);
      await softDeleteRecipe(db, ORG_A, recipe.id);

      // A cutoff in the future makes every trashed row eligible for purge.
      const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const result = await purgeExpired(db, ORG_A, cutoff);
      expect(result.recipes).toBe(1);
      expect(result.transactions).toBe(1);

      // The active, recipe-linked transaction survives with its link nulled.
      const list = await listTransactions(db, ORG_A);
      expect(list).toHaveLength(1);
      expect(list[0]?.recipe).toBeNull();
    });
  });

  describe('Row-Level Security (second defense)', () => {
    it('isolates transactions and categories per org under the tenant_app role', async () => {
      await ensureCategoriesSeeded(db, ORG_A);
      await ensureCategoriesSeeded(db, ORG_B);
      const aSales = await categoryId(ORG_A, 'food_sales');
      const bSales = await categoryId(ORG_B, 'food_sales');
      await createTransaction(db, ORG_A, income(aSales, '2026-06-01', 1_000));
      await createTransaction(db, ORG_B, income(bSales, '2026-06-01', 2_000));

      await db.execute(sql.raw('SET ROLE tenant_app;'));
      try {
        const txns = await runInOrg(db, ORG_A, async (tx) =>
          tx
            .select({ org: transactionsTable.organizationId })
            .from(transactionsTable),
        );
        expect(txns.length).toBeGreaterThan(0);
        expect(txns.every((r) => r.org === ORG_A)).toBe(true);

        const cats = await runInOrg(db, ORG_A, async (tx) =>
          tx
            .select({ org: transactionCategoriesTable.organizationId })
            .from(transactionCategoriesTable),
        );
        expect(cats.every((r) => r.org === ORG_A)).toBe(true);
      } finally {
        await db.execute(sql.raw('RESET ROLE;'));
      }
    });
  });
});
