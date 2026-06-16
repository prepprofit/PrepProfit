import { and, desc, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm';
import { recipes, transactionCategories, transactions } from '@/lib/db/schema';
import type { CategoryKind, Transaction, TransactionType } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';

/**
 * Access to `transactions` is ALWAYS org-scoped (RULE #1); RLS is the second
 * layer. Soft-delete: active reads filter `deleted_at IS NULL`; trashed rows
 * surface only through the trash-scoped reads. Monetary value is a POSITIVE
 * integer-cents magnitude — direction comes from `type`. `occurred_on` is a bare
 * 'YYYY-MM-DD' string (no time, no timezone).
 */

export type TransactionInput = {
  type: TransactionType;
  categoryId: string;
  recipeId: string | null;
  /** 'YYYY-MM-DD'. */
  occurredOn: string;
  /** Positive integer cents. */
  amountCents: number;
  note: string | null;
};

/** A transaction joined with its category + (optional) recipe name, for display. */
export type TransactionListItem = {
  id: string;
  type: TransactionType;
  occurredOn: string;
  amountCents: number;
  note: string | null;
  category: { id: string; slug: string | null; name: string; kind: CategoryKind };
  /** The linked recipe, even if it is trashed (the name is a historical label). */
  recipe: { id: string; name: string } | null;
};

export type TransactionFilter = {
  /** Inclusive lower bound 'YYYY-MM-DD'. */
  from?: string;
  /** Inclusive upper bound 'YYYY-MM-DD'. */
  to?: string;
  type?: TransactionType;
  categoryId?: string;
};

/**
 * Active transactions for the org, newest first, joined with category and recipe
 * name. The category join is INNER (every transaction has a category); the recipe
 * join is LEFT and intentionally NOT filtered by `deleted_at` — a transaction may
 * reference a trashed recipe and we still show its name (purge nulls the link).
 */
export async function listTransactions(
  db: TenantClient,
  organizationId: string,
  filter: TransactionFilter = {},
): Promise<TransactionListItem[]> {
  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      occurredOn: transactions.occurredOn,
      amountCents: transactions.amountCents,
      note: transactions.note,
      categoryId: transactionCategories.id,
      categorySlug: transactionCategories.slug,
      categoryName: transactionCategories.name,
      categoryKind: transactionCategories.kind,
      recipeId: recipes.id,
      recipeName: recipes.name,
    })
    .from(transactions)
    .innerJoin(
      transactionCategories,
      and(
        eq(transactions.categoryId, transactionCategories.id),
        eq(transactionCategories.organizationId, organizationId),
      ),
    )
    .leftJoin(
      recipes,
      and(
        eq(transactions.recipeId, recipes.id),
        eq(recipes.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        isNull(transactions.deletedAt),
        filter.from ? gte(transactions.occurredOn, filter.from) : undefined,
        filter.to ? lte(transactions.occurredOn, filter.to) : undefined,
        filter.type ? eq(transactions.type, filter.type) : undefined,
        filter.categoryId
          ? eq(transactions.categoryId, filter.categoryId)
          : undefined,
      ),
    )
    .orderBy(desc(transactions.occurredOn), desc(transactions.createdAt));

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    occurredOn: r.occurredOn,
    amountCents: r.amountCents,
    note: r.note,
    category: {
      id: r.categoryId,
      slug: r.categorySlug,
      name: r.categoryName,
      kind: r.categoryKind,
    },
    recipe: r.recipeId ? { id: r.recipeId, name: r.recipeName ?? '' } : null,
  }));
}

export async function getTransactionById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Transaction | null> {
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.id, id),
        isNull(transactions.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createTransaction(
  db: TenantClient,
  organizationId: string,
  input: TransactionInput,
): Promise<Transaction> {
  const [row] = await db
    .insert(transactions)
    .values({ ...input, organizationId })
    .returning();
  if (!row) throw new Error('Failed to create transaction.');
  return row;
}

export async function updateTransaction(
  db: TenantClient,
  organizationId: string,
  id: string,
  input: TransactionInput,
): Promise<Transaction | null> {
  const [row] = await db
    .update(transactions)
    .set(input)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.id, id),
        // A trashed transaction must be restored before it can be edited.
        isNull(transactions.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Moves an active transaction to the trash. Returns null if it was not active. */
export async function softDeleteTransaction(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Transaction | null> {
  const [row] = await db
    .update(transactions)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.id, id),
        isNull(transactions.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Brings a trashed transaction back. Returns null if it was not in the trash. */
export async function restoreTransaction(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<Transaction | null> {
  const [row] = await db
    .update(transactions)
    .set({ deletedAt: null })
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.id, id),
        isNotNull(transactions.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Permanently deletes a trashed transaction (only trashed rows are eligible). */
export async function purgeTransaction(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .delete(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.id, id),
        isNotNull(transactions.deletedAt),
      ),
    );
}

export async function listTrashedTransactions(
  db: TenantClient,
  organizationId: string,
): Promise<Transaction[]> {
  return db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        isNotNull(transactions.deletedAt),
      ),
    )
    .orderBy(desc(transactions.deletedAt));
}
