import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  customers,
  ingredients,
  invoices,
  menus,
  purchaseOrders,
  recipes,
  suppliers,
  transactions,
} from '@/lib/db/schema';
import { formatMoney } from '@/lib/format/money';
import { makeSnippet } from './ranking';
import type { SearchCandidate, SearchContext } from './types';

/**
 * Per-entity trigram candidate queries (Sprint 2.7). Every query is:
 *   - org-scoped (`organization_id`, RULE #1) — RLS via `withOrg` is the 2nd layer;
 *   - soft-delete aware (`deleted_at IS NULL`);
 *   - matched with `pg_trgm`: the `%` operator (GIN-index-driven, typo tolerant)
 *     OR an ILIKE substring, so both fuzzy and literal matches surface.
 * The query returns raw relevance signals; ranking happens in the pure `ranking.ts`.
 *
 * `q` (the normalized query) is used verbatim for `%`/`similarity` (not a pattern);
 * only the ILIKE patterns are wildcard-wrapped + escaped.
 */

/** Escape LIKE/ILIKE metacharacters so user input can't act as a wildcard. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Coerce a driver-returned similarity (number or numeric-string) to a number. */
function toNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function searchRecipes(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const { tx, organizationId, query, limit } = ctx;
  const like = `%${escapeLike(query)}%`;
  const prefixLike = `${escapeLike(query)}%`;

  const rows = await tx
    .select({
      id: recipes.id,
      name: recipes.name,
      notes: recipes.notes,
      primarySim: sql<number>`similarity(${recipes.name}, ${query})`,
      secondarySim: sql<number>`similarity(coalesce(${recipes.notes}, ''), ${query})`,
      exact: sql<boolean>`lower(${recipes.name}) = lower(${query})`,
      prefix: sql<boolean>`${recipes.name} ILIKE ${prefixLike}`,
      substring: sql<boolean>`${recipes.name} ILIKE ${like}`,
    })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        isNull(recipes.deletedAt),
        sql`(${recipes.name} % ${query} OR ${recipes.name} ILIKE ${like} OR coalesce(${recipes.notes}, '') % ${query})`,
      ),
    )
    .orderBy(
      sql`GREATEST(similarity(${recipes.name}, ${query}), similarity(coalesce(${recipes.notes}, ''), ${query})) DESC`,
    )
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    title: r.name,
    subtitle: r.notes ? makeSnippet(r.notes, query) : null,
    href: `/recipes/${r.id}`,
    primarySim: toNum(r.primarySim),
    secondarySim: toNum(r.secondarySim),
    exact: r.exact === true,
    prefix: r.prefix === true,
    substring: r.substring === true,
  }));
}

export async function searchMenus(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const { tx, organizationId, query, limit } = ctx;
  const like = `%${escapeLike(query)}%`;
  const prefixLike = `${escapeLike(query)}%`;

  // Active menus only; match on the name. NO monetary subtitle — menus are
  // kitchen-accessible (F4), so a search row never carries price/cost.
  const rows = await tx
    .select({
      id: menus.id,
      name: menus.name,
      primarySim: sql<number>`similarity(${menus.name}, ${query})`,
      exact: sql<boolean>`lower(${menus.name}) = lower(${query})`,
      prefix: sql<boolean>`${menus.name} ILIKE ${prefixLike}`,
      substring: sql<boolean>`${menus.name} ILIKE ${like}`,
    })
    .from(menus)
    .where(
      and(
        eq(menus.organizationId, organizationId),
        isNull(menus.deletedAt),
        sql`(${menus.name} % ${query} OR ${menus.name} ILIKE ${like})`,
      ),
    )
    .orderBy(sql`similarity(${menus.name}, ${query}) DESC`)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    title: r.name,
    subtitle: null,
    href: `/menus/${r.id}`,
    primarySim: toNum(r.primarySim),
    secondarySim: 0,
    exact: r.exact === true,
    prefix: r.prefix === true,
    substring: r.substring === true,
  }));
}

export async function searchIngredients(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const { tx, organizationId, query, limit } = ctx;
  const like = `%${escapeLike(query)}%`;
  const prefixLike = `${escapeLike(query)}%`;

  const rows = await tx
    .select({
      id: ingredients.id,
      name: ingredients.name,
      supplier: ingredients.supplier,
      primarySim: sql<number>`similarity(${ingredients.name}, ${query})`,
      secondarySim: sql<number>`similarity(coalesce(${ingredients.supplier}, ''), ${query})`,
      exact: sql<boolean>`lower(${ingredients.name}) = lower(${query})`,
      prefix: sql<boolean>`${ingredients.name} ILIKE ${prefixLike}`,
      substring: sql<boolean>`${ingredients.name} ILIKE ${like}`,
    })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNull(ingredients.deletedAt),
        sql`(${ingredients.name} % ${query} OR ${ingredients.name} ILIKE ${like} OR coalesce(${ingredients.supplier}, '') % ${query})`,
      ),
    )
    .orderBy(
      sql`GREATEST(similarity(${ingredients.name}, ${query}), similarity(coalesce(${ingredients.supplier}, ''), ${query})) DESC`,
    )
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    title: r.name,
    subtitle: r.supplier,
    href: `/ingredients?highlight=${r.id}`,
    primarySim: toNum(r.primarySim),
    secondarySim: toNum(r.secondarySim),
    exact: r.exact === true,
    prefix: r.prefix === true,
    substring: r.substring === true,
  }));
}

export async function searchTransactions(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const { tx, organizationId, query, limit, currency } = ctx;
  const like = `%${escapeLike(query)}%`;
  const prefixLike = `${escapeLike(query)}%`;

  // Only the free-text note is searchable; NULL-note rows can never match the
  // `%`/ILIKE predicate, so they are naturally excluded.
  const rows = await tx
    .select({
      id: transactions.id,
      note: transactions.note,
      type: transactions.type,
      occurredOn: transactions.occurredOn,
      amountCents: transactions.amountCents,
      primarySim: sql<number>`similarity(coalesce(${transactions.note}, ''), ${query})`,
      exact: sql<boolean>`lower(coalesce(${transactions.note}, '')) = lower(${query})`,
      prefix: sql<boolean>`coalesce(${transactions.note}, '') ILIKE ${prefixLike}`,
      substring: sql<boolean>`coalesce(${transactions.note}, '') ILIKE ${like}`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        isNull(transactions.deletedAt),
        sql`(${transactions.note} % ${query} OR ${transactions.note} ILIKE ${like})`,
      ),
    )
    .orderBy(sql`similarity(coalesce(${transactions.note}, ''), ${query}) DESC`)
    .limit(limit);

  return rows.map((r) => {
    const amount = formatMoney(r.amountCents, currency);
    const signed = r.type === 'expense' ? `−${amount}` : amount;
    return {
      id: r.id,
      title: r.note ? makeSnippet(r.note, query, 60) : amount,
      subtitle: `${signed} · ${r.occurredOn}`,
      href: `/transactions?highlight=${r.id}`,
      primarySim: toNum(r.primarySim),
      secondarySim: 0,
      exact: r.exact === true,
      prefix: r.prefix === true,
      substring: r.substring === true,
    };
  });
}

export async function searchInvoices(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const { tx, organizationId, query, limit } = ctx;
  const like = `%${escapeLike(query)}%`;
  const prefixLike = `${escapeLike(query)}%`;

  // Match on the invoice number OR the (frozen) customer-name snapshot. Drafts
  // have a NULL number, so they surface only by their customer name.
  const rows = await tx
    .select({
      id: invoices.id,
      number: invoices.number,
      customerName: invoices.customerName,
      status: invoices.status,
      totalCents: invoices.totalCents,
      primarySim: sql<number>`similarity(coalesce(${invoices.number}, ''), ${query})`,
      secondarySim: sql<number>`similarity(coalesce(${invoices.customerName}, ''), ${query})`,
      exact: sql<boolean>`lower(coalesce(${invoices.number}, '')) = lower(${query})`,
      prefix: sql<boolean>`coalesce(${invoices.number}, '') ILIKE ${prefixLike}`,
      substring: sql<boolean>`coalesce(${invoices.number}, '') ILIKE ${like}`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        isNull(invoices.deletedAt),
        sql`(${invoices.number} % ${query} OR ${invoices.number} ILIKE ${like} OR coalesce(${invoices.customerName}, '') % ${query} OR coalesce(${invoices.customerName}, '') ILIKE ${like})`,
      ),
    )
    .orderBy(
      sql`GREATEST(similarity(coalesce(${invoices.number}, ''), ${query}), similarity(coalesce(${invoices.customerName}, ''), ${query})) DESC`,
    )
    .limit(limit);

  return rows.map((r) => {
    const amount = formatMoney(r.totalCents, ctx.currency);
    return {
      id: r.id,
      title: r.number ?? r.customerName ?? amount,
      subtitle: r.number ? (r.customerName ?? amount) : amount,
      href: `/invoices/${r.id}`,
      primarySim: toNum(r.primarySim),
      secondarySim: toNum(r.secondarySim),
      exact: r.exact === true,
      prefix: r.prefix === true,
      substring: r.substring === true,
    };
  });
}

export async function searchCustomers(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const { tx, organizationId, query, limit } = ctx;
  const like = `%${escapeLike(query)}%`;
  const prefixLike = `${escapeLike(query)}%`;

  const rows = await tx
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      taxId: customers.taxId,
      primarySim: sql<number>`similarity(${customers.name}, ${query})`,
      secondarySim: sql<number>`similarity(coalesce(${customers.email}, ''), ${query})`,
      exact: sql<boolean>`lower(${customers.name}) = lower(${query})`,
      prefix: sql<boolean>`${customers.name} ILIKE ${prefixLike}`,
      substring: sql<boolean>`${customers.name} ILIKE ${like}`,
    })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, organizationId),
        isNull(customers.deletedAt),
        sql`(${customers.name} % ${query} OR ${customers.name} ILIKE ${like} OR coalesce(${customers.email}, '') % ${query})`,
      ),
    )
    .orderBy(
      sql`GREATEST(similarity(${customers.name}, ${query}), similarity(coalesce(${customers.email}, ''), ${query})) DESC`,
    )
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    title: r.name,
    subtitle: r.email ?? r.taxId,
    href: `/invoices`,
    primarySim: toNum(r.primarySim),
    secondarySim: toNum(r.secondarySim),
    exact: r.exact === true,
    prefix: r.prefix === true,
    substring: r.substring === true,
  }));
}

export async function searchPurchaseOrders(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const { tx, organizationId, query, limit } = ctx;
  const like = `%${escapeLike(query)}%`;
  const prefixLike = `${escapeLike(query)}%`;

  // Match on the PO number (as text) OR the frozen supplier-name snapshot. Drafts
  // have a NULL supplier_name snapshot, so they surface only by number. No
  // soft-delete on POs (status drives lifecycle), so every PO is searchable.
  const rows = await tx
    .select({
      id: purchaseOrders.id,
      number: purchaseOrders.number,
      supplierName: purchaseOrders.supplierName,
      status: purchaseOrders.status,
      totalCents: purchaseOrders.totalCents,
      primarySim: sql<number>`similarity(coalesce(${purchaseOrders.supplierName}, ''), ${query})`,
      exact: sql<boolean>`lower(${purchaseOrders.number}::text) = lower(${query}) OR lower(coalesce(${purchaseOrders.supplierName}, '')) = lower(${query})`,
      prefix: sql<boolean>`${purchaseOrders.number}::text ILIKE ${prefixLike} OR coalesce(${purchaseOrders.supplierName}, '') ILIKE ${prefixLike}`,
      substring: sql<boolean>`${purchaseOrders.number}::text ILIKE ${like} OR coalesce(${purchaseOrders.supplierName}, '') ILIKE ${like}`,
    })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.organizationId, organizationId),
        sql`(${purchaseOrders.supplierName} % ${query} OR ${purchaseOrders.supplierName} ILIKE ${like} OR ${purchaseOrders.number}::text ILIKE ${like})`,
      ),
    )
    .orderBy(
      sql`similarity(coalesce(${purchaseOrders.supplierName}, ''), ${query}) DESC`,
    )
    .limit(limit);

  return rows.map((r) => {
    const number = `PO-${String(r.number).padStart(4, '0')}`;
    const amount = formatMoney(r.totalCents, ctx.currency);
    return {
      id: r.id,
      title: number,
      subtitle: r.supplierName ?? amount,
      href: `/purchase-orders?highlight=${r.id}`,
      primarySim: toNum(r.primarySim),
      secondarySim: 0,
      exact: r.exact === true,
      prefix: r.prefix === true,
      substring: r.substring === true,
    };
  });
}

export async function searchSuppliers(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const { tx, organizationId, query, limit } = ctx;
  const like = `%${escapeLike(query)}%`;
  const prefixLike = `${escapeLike(query)}%`;

  // Suppliers have no soft-delete (archive flag): both active and archived match,
  // so a manager can still find an archived supplier to reactivate.
  const rows = await tx
    .select({
      id: suppliers.id,
      name: suppliers.name,
      email: suppliers.email,
      active: suppliers.active,
      primarySim: sql<number>`similarity(${suppliers.name}, ${query})`,
      secondarySim: sql<number>`similarity(coalesce(${suppliers.email}, ''), ${query})`,
      exact: sql<boolean>`lower(${suppliers.name}) = lower(${query})`,
      prefix: sql<boolean>`${suppliers.name} ILIKE ${prefixLike}`,
      substring: sql<boolean>`${suppliers.name} ILIKE ${like}`,
    })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.organizationId, organizationId),
        sql`(${suppliers.name} % ${query} OR ${suppliers.name} ILIKE ${like} OR coalesce(${suppliers.email}, '') % ${query})`,
      ),
    )
    .orderBy(
      sql`GREATEST(similarity(${suppliers.name}, ${query}), similarity(coalesce(${suppliers.email}, ''), ${query})) DESC`,
    )
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    title: r.name,
    subtitle: r.email,
    href: `/suppliers?highlight=${r.id}`,
    primarySim: toNum(r.primarySim),
    secondarySim: toNum(r.secondarySim),
    exact: r.exact === true,
    prefix: r.prefix === true,
    substring: r.substring === true,
  }));
}
