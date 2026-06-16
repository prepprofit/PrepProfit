import { and, asc, eq, isNull } from 'drizzle-orm';
import { transactionCategories } from '@/lib/db/schema';
import type { CategoryKind, TransactionCategory } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { CATEGORY_SEED } from '@/lib/finance/categories';

/**
 * Access to `transaction_categories` is ALWAYS org-scoped (RULE #1) — derived on
 * the server, RLS as the second layer. Predefined categories are seeded as rows
 * (a stable `slug`) so reports group by id and renames never orphan a row; custom
 * per-org categories are rows with `slug = null`. `isSystem = slug != null`.
 */

/** A category in display shape, with `isSystem` derived from the slug. */
export type CategoryView = {
  id: string;
  slug: string | null;
  /** Row fallback; for predefined rows the UI prefers i18n finance.categories.<slug>. */
  name: string;
  kind: CategoryKind;
  sortOrder: number;
  isSystem: boolean;
};

function toView(row: TransactionCategory): CategoryView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    sortOrder: row.sortOrder,
    isSystem: row.slug != null,
  };
}

/**
 * Idempotently seeds the predefined categories for an organization. MUST run
 * inside the org transaction (the RLS GUC is set there). `ON CONFLICT (org, slug)
 * DO NOTHING` makes it safe to call before any categories read or transaction
 * create — org-creation webhooks (Sprint 4) would do this eagerly instead.
 */
export async function ensureCategoriesSeeded(
  db: TenantClient,
  organizationId: string,
): Promise<void> {
  await db
    .insert(transactionCategories)
    .values(
      CATEGORY_SEED.map((c, index) => ({
        organizationId,
        slug: c.slug,
        name: c.name,
        kind: c.kind,
        sortOrder: index,
      })),
    )
    .onConflictDoNothing({
      target: [transactionCategories.organizationId, transactionCategories.slug],
    });
}

/** Predefined first (by seed order), then custom (alphabetical). Filter by kind. */
export async function listCategories(
  db: TenantClient,
  organizationId: string,
  kind?: CategoryKind,
): Promise<CategoryView[]> {
  const rows = await db
    .select()
    .from(transactionCategories)
    .where(
      and(
        eq(transactionCategories.organizationId, organizationId),
        kind ? eq(transactionCategories.kind, kind) : undefined,
      ),
    )
    .orderBy(
      asc(transactionCategories.sortOrder),
      asc(transactionCategories.name),
    );
  return rows.map(toView);
}

export async function getCategoryById(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<CategoryView | null> {
  const rows = await db
    .select()
    .from(transactionCategories)
    .where(
      and(
        eq(transactionCategories.organizationId, organizationId),
        eq(transactionCategories.id, id),
      ),
    )
    .limit(1);
  return rows[0] ? toView(rows[0]) : null;
}

/**
 * Creates a custom category (`slug = null`). Sorts after the predefined block
 * (which uses indices 0..n) via a high base order.
 */
export async function createCustomCategory(
  db: TenantClient,
  organizationId: string,
  name: string,
  kind: CategoryKind,
): Promise<TransactionCategory> {
  const [row] = await db
    .insert(transactionCategories)
    .values({ organizationId, slug: null, name, kind, sortOrder: 1000 })
    .returning();
  if (!row) throw new Error('Failed to create category.');
  return row;
}

/**
 * Renames a CUSTOM category. Predefined rows (slug set) are not renamable — their
 * name is i18n-driven — so the `slug IS NULL` filter makes a predefined id a no-op
 * (returns null → NOT_FOUND).
 */
export async function renameCustomCategory(
  db: TenantClient,
  organizationId: string,
  id: string,
  name: string,
): Promise<TransactionCategory | null> {
  const [row] = await db
    .update(transactionCategories)
    .set({ name })
    .where(
      and(
        eq(transactionCategories.organizationId, organizationId),
        eq(transactionCategories.id, id),
        isNull(transactionCategories.slug),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Deletes a CUSTOM category. Predefined rows are protected by the `slug IS NULL`
 * filter. The `transactions_category_fk` is `ON DELETE restrict`, so a category
 * still in use raises a foreign-key violation the action maps to CATEGORY_IN_USE.
 * Returns false when nothing was deleted (not found or predefined).
 */
export async function deleteCustomCategory(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(transactionCategories)
    .where(
      and(
        eq(transactionCategories.organizationId, organizationId),
        eq(transactionCategories.id, id),
        isNull(transactionCategories.slug),
      ),
    )
    .returning({ id: transactionCategories.id });
  return deleted.length > 0;
}
