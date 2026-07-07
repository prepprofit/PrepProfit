import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { recipes, transactionCategories, transactions } from '@/lib/db/schema';
import type { CategoryKind, Transaction, TransactionType } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import {
  ensureCategoriesSeeded,
  getCategoryIdBySlug,
} from '@/lib/data/transaction-categories';

/**
 * A sale-sourced transaction (`source_type='sale'`, Sprint F5) is the financial
 * projection of a posted sale, owned SOLELY by the sale lifecycle. The generic
 * mutators carry this backstop predicate so a forged/concurrent path can never
 * touch one. `IS DISTINCT FROM` (not `<> 'sale'`) is required — `<>` would also
 * exclude the NULL-source NORMAL rows, breaking legitimate edits.
 */
const notSaleSourced = sql`${transactions.sourceType} is distinct from 'sale'`;

/** The stable system category that every posted sale's income row is filed under. */
export const DAILY_SALES_CATEGORY_SLUG = 'daily_sales';

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
  /** Cap the result set (newest first). */
  limit?: number;
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
  const baseQuery = db
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

  const rows = await (filter.limit !== undefined
    ? baseQuery.limit(filter.limit)
    : baseQuery);

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
        // Sale-sourced rows are owned by the sale lifecycle (Sprint F5).
        notSaleSourced,
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
        notSaleSourced,
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
        notSaleSourced,
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
        notSaleSourced,
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
        // A voided sale is NOT user-trash — it is a retained historical projection.
        notSaleSourced,
      ),
    )
    .orderBy(desc(transactions.deletedAt));
}

/**
 * Load a transaction by id REGARDLESS of soft-delete state, for the action-layer
 * protected-row guard (Sprint F5). Lets an action distinguish, atomically inside
 * the same `withOrg`, NOT_FOUND (no row) from PROTECTED (a `source_type='sale'`
 * row) before attempting a mutation. Org-scoped (RULE #1).
 */
export async function getTransactionAnyState(
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
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Outcome of {@link postSaleTransaction}. Mirrors the F1 idempotency contract. */
export type PostSaleResult =
  // `deduped` = an identical posting already exists for this saleId; no new row.
  | { ok: true; transaction: Transaction; deduped?: true }
  // The same saleId already posted a DIFFERENT amount/date — never overwritten.
  | { ok: false; reason: 'idempotency_conflict' };

/**
 * Post the single PROTECTED income transaction for a posted sale (Sprint F5
 * primitive; the `sales` table + lifecycle arrive in Sprint 12a). The invariants
 * are FIXED here so the caller can never bend them: `type='income'`, `amount_cents
 * = grossCents`, `recipe_id = NULL`, `source_type='sale'`, `source_id=saleId`, and
 * the category is the stable SYSTEM `daily_sales` row (resolved/seeded per org —
 * never a caller-supplied id).
 *
 * Idempotent WITH conflict detection (mirrors `recordMovement`, NOT a silent
 * ignore): `INSERT … ON CONFLICT (org, source_type, source_id) DO NOTHING
 * RETURNING`; on no row, re-fetch the existing sale row and compare the payload —
 * identical amount+date → `deduped`, different → `idempotency_conflict` (the
 * original is never overwritten). Must run inside the sale-post `withOrg`.
 */
export async function postSaleTransaction(
  db: TenantClient,
  organizationId: string,
  params: { saleId: string; grossCents: number; occurredOn: string },
): Promise<PostSaleResult> {
  await ensureCategoriesSeeded(db, organizationId);
  const categoryId = await getCategoryIdBySlug(
    db,
    organizationId,
    DAILY_SALES_CATEGORY_SLUG,
  );
  if (!categoryId) {
    throw new Error('daily_sales system category missing after seeding.');
  }

  const inserted = await db
    .insert(transactions)
    .values({
      organizationId,
      type: 'income',
      categoryId,
      recipeId: null,
      occurredOn: params.occurredOn,
      amountCents: params.grossCents,
      note: null,
      sourceType: 'sale',
      sourceId: params.saleId,
    })
    .onConflictDoNothing({
      target: [
        transactions.organizationId,
        transactions.sourceType,
        transactions.sourceId,
      ],
      // Match the PARTIAL unique index predicate so Postgres infers it.
      where: sql`${transactions.sourceType} is not null`,
    })
    .returning();

  if (inserted[0]) return { ok: true, transaction: inserted[0] };

  // No row inserted → a posting already exists for this saleId. Re-fetch it and
  // compare the immutable payload: identical = deduped, different = conflict.
  const [existing] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.sourceType, 'sale'),
        eq(transactions.sourceId, params.saleId),
      ),
    )
    .limit(1);
  if (
    existing &&
    existing.amountCents === params.grossCents &&
    existing.occurredOn === params.occurredOn
  ) {
    return { ok: true, transaction: existing, deduped: true };
  }
  return { ok: false, reason: 'idempotency_conflict' };
}

/**
 * Soft-delete the income transaction linked to a voided sale (Sprint F5
 * primitive). This is the ONLY path allowed to soft-delete a sale-sourced row;
 * Sprint 12a calls it inside the sale-void `withOrg` (alongside the status flip,
 * F1 stock reversals and audit). IDEMPOTENT: a second void is a no-op (the
 * `deleted_at IS NULL` guard matches nothing the second time) → returns null,
 * never a second state change. Returns the voided row on the first call.
 */
export async function voidSaleTransaction(
  db: TenantClient,
  organizationId: string,
  saleId: string,
): Promise<Transaction | null> {
  const [row] = await db
    .update(transactions)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.sourceType, 'sale'),
        eq(transactions.sourceId, saleId),
        isNull(transactions.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}
