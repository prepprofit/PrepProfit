import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ingredients,
  inventoryMovements,
  menuItems,
  menus,
  recipeIngredients,
  recipes,
  saleItems,
  sales,
  transactions,
} from '@/lib/db/schema';
import type { Sale, SaleItem, SaleItemKind } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { Dimension } from '@/lib/units';
import { saleLineTotals, saleTotals, type SaleLineInput as TaxLineInput } from '@/lib/calculations/tax';
import {
  explodeSaleConsumption,
  type SaleIngredientLine,
  type SaleRecipeInput,
} from '@/lib/calculations/sale-consumption';
import {
  buildMovementKey,
  recordMovements,
  type RecordMovementInput,
} from '@/lib/data/inventory';
import { getOrgSettingsRow } from '@/lib/data/org-settings';
import { postSaleTransaction, voidSaleTransaction } from '@/lib/data/transactions';
import { movesStock } from '@/lib/finance/stock-control';

/**
 * Daily-close Sales data layer (Sprint 12a). Every function is org-scoped (RULE #1)
 * and runs inside the caller's `withOrg` transaction so RLS is active. Sales are
 * FINANCIAL → manager-only at the action layer (F4); this module assumes the role
 * check already passed.
 *
 * The single revenue source is the F5 primitive `postSaleTransaction` (the income
 * row's invariants are fixed there). Stock consumption goes through the F1 ledger
 * (`recordMovements`) only when `movesStock` is true at the sale date. Money is
 * integer cents; the frozen sale/line totals come from lib/calculations/tax.ts
 * (single exclusive org rate, per-line-then-sum). Optimistic concurrency + `FOR
 * UPDATE` on every mutation (the productions lock shape).
 */

// ── Validated inputs ──────────────────────────────────────────────────────────

/** One validated sale line (the action has Zod-checked ranges + the source shape). */
export type SaleLineInput = {
  itemKind: SaleItemKind;
  itemRecipeId: string | null;
  itemMenuId: string | null;
  itemIngredientId: string | null;
  /** Units sold (integer ≥ 1). */
  quantity: number;
  /** Canonical stock consumed per sold unit — set iff itemKind === 'ingredient'. */
  ingredientQtyCanonical: number | null;
  /** Net price per sold unit (integer cents). */
  unitNetCents: number;
  /** Per-line tax rate in basis points (0..10000), defaulted from the org rate. */
  taxRateBps: number;
};

export type SaleFields = {
  /** 'YYYY-MM-DD'. */
  saleDate: string;
  note: string | null;
};

// ── Display views ───────────────────────────────────────────────────────────

export type SaleListItem = {
  id: string;
  saleDate: string;
  status: Sale['status'];
  lineCount: number;
  /** Frozen gross (cents); null while draft. */
  grossCents: number | null;
};

/** One line as the editor / read-only view shows it. */
export type SaleLineView = {
  id: string;
  itemKind: SaleItemKind;
  itemRecipeId: string | null;
  itemMenuId: string | null;
  itemIngredientId: string | null;
  itemName: string;
  quantity: number;
  ingredientQtyCanonical: number | null;
  unitNetCents: number;
  taxRateBps: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
  sortOrder: number;
  /** Whether the referenced catalogue item is still active (informational). */
  available: boolean;
};

/** One booked OUT movement on a posted (stock-moving) sale (money-free readout). */
export type SaleConsumptionView = {
  ingredientId: string;
  ingredientName: string;
  qtyCanonical: number;
};

export type SaleDetail = {
  id: string;
  saleDate: string;
  status: Sale['status'];
  note: string | null;
  /** ISO timestamp the client echoes back as `expectedUpdatedAt` (optimistic lock). */
  updatedAt: string;
  postedAt: string | null;
  voidedAt: string | null;
  stockMoved: boolean;
  netCents: number | null;
  taxCents: number | null;
  grossCents: number | null;
  lines: SaleLineView[];
  /** The linked income transaction id once posted (even if voided/soft-deleted). */
  transactionId: string | null;
  /** Booked consumed ingredients when stock_moved; empty otherwise. */
  consumptions: SaleConsumptionView[];
};

// ── Reads ───────────────────────────────────────────────────────────────────

/** Active sales newest-first, with line counts + frozen gross for display. */
export async function listSales(
  db: TenantClient,
  organizationId: string,
): Promise<SaleListItem[]> {
  const rows = await db
    .select()
    .from(sales)
    .where(eq(sales.organizationId, organizationId))
    .orderBy(desc(sales.saleDate), desc(sales.createdAt));
  if (rows.length === 0) return [];

  const counts = await db
    .select({ saleId: saleItems.saleId, value: count() })
    .from(saleItems)
    .where(
      and(
        eq(saleItems.organizationId, organizationId),
        inArray(
          saleItems.saleId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .groupBy(saleItems.saleId);
  const countBySale = new Map(counts.map((c) => [c.saleId, c.value]));

  return rows.map((sale) => ({
    id: sale.id,
    saleDate: sale.saleDate,
    status: sale.status,
    lineCount: countBySale.get(sale.id) ?? 0,
    grossCents: sale.grossCents,
  }));
}

/** One sale with its items + (for posted sales) the linked transaction + movements. */
export async function getSaleWithItems(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<SaleDetail | null> {
  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.organizationId, organizationId), eq(sales.id, id)))
    .limit(1);
  if (!sale) return null;

  const items = await db
    .select()
    .from(saleItems)
    .where(
      and(eq(saleItems.organizationId, organizationId), eq(saleItems.saleId, id)),
    )
    .orderBy(asc(saleItems.sortOrder));

  // Resolve current availability of each referenced source (informational).
  const recipeIds = [...new Set(items.filter((i) => i.itemRecipeId).map((i) => i.itemRecipeId!))];
  const menuIds = [...new Set(items.filter((i) => i.itemMenuId).map((i) => i.itemMenuId!))];
  const ingredientIds = [
    ...new Set(items.filter((i) => i.itemIngredientId).map((i) => i.itemIngredientId!)),
  ];
  const [recipeActive, menuActive, ingredientActive] = await Promise.all([
    loadActiveIds(db, organizationId, recipes, recipeIds),
    loadActiveIds(db, organizationId, menus, menuIds),
    loadActiveIds(db, organizationId, ingredients, ingredientIds),
  ]);

  const lineAvailable = (item: SaleItem): boolean => {
    if (item.itemKind === 'recipe') return recipeActive.has(item.itemRecipeId ?? '');
    if (item.itemKind === 'menu') return menuActive.has(item.itemMenuId ?? '');
    return ingredientActive.has(item.itemIngredientId ?? '');
  };

  // The linked income transaction (any state) + booked OUT movements, if posted.
  let transactionId: string | null = null;
  let consumptions: SaleConsumptionView[] = [];
  if (sale.status !== 'draft') {
    transactionId = await findSaleTransactionId(db, organizationId, id);

    if (sale.stockMoved) {
      const moves = await db
        .select({
          ingredientId: inventoryMovements.ingredientId,
          deltaCanonical: inventoryMovements.deltaCanonical,
          ingredientName: ingredients.name,
        })
        .from(inventoryMovements)
        .innerJoin(
          ingredients,
          and(
            eq(inventoryMovements.ingredientId, ingredients.id),
            eq(ingredients.organizationId, organizationId),
          ),
        )
        .where(
          and(
            eq(inventoryMovements.organizationId, organizationId),
            eq(inventoryMovements.sourceType, 'sale'),
            eq(inventoryMovements.sourceId, id),
          ),
        )
        .orderBy(asc(ingredients.name));
      consumptions = moves.map((m) => ({
        ingredientId: m.ingredientId,
        ingredientName: m.ingredientName,
        // Stored as a negative OUT delta; show the positive consumed magnitude.
        qtyCanonical: Math.abs(Number(m.deltaCanonical)),
      }));
    }
  }

  return {
    id: sale.id,
    saleDate: sale.saleDate,
    status: sale.status,
    note: sale.note,
    updatedAt: sale.updatedAt.toISOString(),
    postedAt: sale.postedAt ? sale.postedAt.toISOString() : null,
    voidedAt: sale.voidedAt ? sale.voidedAt.toISOString() : null,
    stockMoved: sale.stockMoved,
    netCents: sale.netCents,
    taxCents: sale.taxCents,
    grossCents: sale.grossCents,
    lines: items.map((item) => ({
      id: item.id,
      itemKind: item.itemKind,
      itemRecipeId: item.itemRecipeId,
      itemMenuId: item.itemMenuId,
      itemIngredientId: item.itemIngredientId,
      itemName: item.itemName,
      quantity: item.quantity,
      ingredientQtyCanonical:
        item.ingredientQtyCanonical === null ? null : Number(item.ingredientQtyCanonical),
      unitNetCents: item.unitNetCents,
      taxRateBps: item.taxRateBps,
      netCents: item.netCents,
      taxCents: item.taxCents,
      grossCents: item.grossCents,
      sortOrder: item.sortOrder,
      available: lineAvailable(item),
    })),
    transactionId,
    consumptions,
  };
}

// ── Editor option loaders (money-free identity for the line picker) ───────────

export type SaleItemOption = { id: string; name: string };
export type SaleIngredientOption = SaleItemOption & { dimension: Dimension };

/** Active recipes as sale-line options (id + name). */
export async function listSaleRecipeOptions(
  db: TenantClient,
  organizationId: string,
): Promise<SaleItemOption[]> {
  return db
    .select({ id: recipes.id, name: recipes.name })
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), isNull(recipes.deletedAt)))
    .orderBy(asc(recipes.name));
}

/** Active menus as sale-line options (id + name). */
export async function listSaleMenuOptions(
  db: TenantClient,
  organizationId: string,
): Promise<SaleItemOption[]> {
  return db
    .select({ id: menus.id, name: menus.name })
    .from(menus)
    .where(and(eq(menus.organizationId, organizationId), isNull(menus.deletedAt)))
    .orderBy(asc(menus.name));
}

/** Active ingredients as sale-line options (id + name + dimension). */
export async function listSaleIngredientOptions(
  db: TenantClient,
  organizationId: string,
): Promise<SaleIngredientOption[]> {
  return db
    .select({ id: ingredients.id, name: ingredients.name, dimension: ingredients.dimension })
    .from(ingredients)
    .where(and(eq(ingredients.organizationId, organizationId), isNull(ingredients.deletedAt)))
    .orderBy(asc(ingredients.name));
}

// ── Shared resolution helpers ─────────────────────────────────────────────────

type ActiveTable = typeof recipes | typeof menus | typeof ingredients;

/** Ids among `ids` that resolve to an ACTIVE same-org row of `table`. */
async function loadActiveIds(
  db: TenantClient,
  organizationId: string,
  table: ActiveTable,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.organizationId, organizationId),
        inArray(table.id, ids),
        isNull(table.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Resolved name + availability for a source kind, INCLUDING trashed rows. */
type NameInfo = { name: string; available: boolean };

async function loadNames(
  db: TenantClient,
  organizationId: string,
  table: ActiveTable,
  ids: string[],
): Promise<Map<string, NameInfo>> {
  const map = new Map<string, NameInfo>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: table.id, name: table.name, deletedAt: table.deletedAt })
    .from(table)
    .where(and(eq(table.organizationId, organizationId), inArray(table.id, ids)));
  for (const r of rows) map.set(r.id, { name: r.name, available: r.deletedAt === null });
  return map;
}

/** Line net/tax/gross from the raw line fields (the tax module is the only money). */
function computeLineMoney(line: {
  quantity: number;
  unitNetCents: number;
  taxRateBps: number;
}): { netCents: number; taxCents: number; grossCents: number } {
  return saleLineTotals({
    netCents: line.quantity * line.unitNetCents,
    bps: line.taxRateBps,
  });
}

/** The frozen item_name a line should carry, resolved from the source maps. */
function resolveItemName(
  line: SaleLineInput,
  recipeNames: Map<string, NameInfo>,
  menuNames: Map<string, NameInfo>,
  ingredientNames: Map<string, NameInfo>,
): string | null {
  if (line.itemKind === 'recipe') {
    return recipeNames.get(line.itemRecipeId ?? '')?.name ?? null;
  }
  if (line.itemKind === 'menu') {
    return menuNames.get(line.itemMenuId ?? '')?.name ?? null;
  }
  return ingredientNames.get(line.itemIngredientId ?? '')?.name ?? null;
}

/**
 * Lock + resolve every referenced source for a line set, returning name maps. Locks
 * recipes/menus/ingredients FOR UPDATE in id order (deadlock-free) so a concurrent
 * trash serializes. `allActive` is true only when EVERY referenced source resolves
 * to an ACTIVE same-org row.
 */
async function lockAndResolveSources(
  db: TenantClient,
  organizationId: string,
  lines: SaleLineInput[],
): Promise<{
  allActive: boolean;
  recipeNames: Map<string, NameInfo>;
  menuNames: Map<string, NameInfo>;
  ingredientNames: Map<string, NameInfo>;
}> {
  const recipeIds = distinct(lines.filter((l) => l.itemRecipeId).map((l) => l.itemRecipeId!));
  const menuIds = distinct(lines.filter((l) => l.itemMenuId).map((l) => l.itemMenuId!));
  const ingredientIds = distinct(
    lines.filter((l) => l.itemIngredientId).map((l) => l.itemIngredientId!),
  );

  // Lock referenced rows (all states, id order) so a racing trash serializes.
  await lockRows(db, organizationId, recipes, recipeIds);
  await lockRows(db, organizationId, menus, menuIds);
  await lockRows(db, organizationId, ingredients, ingredientIds);

  const [recipeNames, menuNames, ingredientNames] = await Promise.all([
    loadNames(db, organizationId, recipes, recipeIds),
    loadNames(db, organizationId, menus, menuIds),
    loadNames(db, organizationId, ingredients, ingredientIds),
  ]);

  const allActive = lines.every((l) => {
    if (l.itemKind === 'recipe') return recipeNames.get(l.itemRecipeId ?? '')?.available === true;
    if (l.itemKind === 'menu') return menuNames.get(l.itemMenuId ?? '')?.available === true;
    return ingredientNames.get(l.itemIngredientId ?? '')?.available === true;
  });

  return { allActive, recipeNames, menuNames, ingredientNames };
}

async function lockRows(
  db: TenantClient,
  organizationId: string,
  table: ActiveTable,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.organizationId, organizationId), inArray(table.id, ids)))
    .orderBy(asc(table.id))
    .for('update');
}

function distinct(ids: string[]): string[] {
  return [...new Set(ids)];
}

async function insertSaleItems(
  db: TenantClient,
  organizationId: string,
  saleId: string,
  lines: SaleLineInput[],
  recipeNames: Map<string, NameInfo>,
  menuNames: Map<string, NameInfo>,
  ingredientNames: Map<string, NameInfo>,
): Promise<void> {
  await db.insert(saleItems).values(
    lines.map((line, index) => {
      const money = computeLineMoney(line);
      const name = resolveItemName(line, recipeNames, menuNames, ingredientNames) ?? '';
      return {
        organizationId,
        saleId,
        itemKind: line.itemKind,
        itemRecipeId: line.itemRecipeId,
        itemMenuId: line.itemMenuId,
        itemIngredientId: line.itemIngredientId,
        itemName: name,
        quantity: line.quantity,
        ingredientQtyCanonical:
          line.ingredientQtyCanonical === null ? null : line.ingredientQtyCanonical.toString(),
        unitNetCents: line.unitNetCents,
        taxRateBps: line.taxRateBps,
        netCents: money.netCents,
        taxCents: money.taxCents,
        grossCents: money.grossCents,
        sortOrder: index,
      };
    }),
  );
}

// ── Draft mutations ───────────────────────────────────────────────────────────

export type CreateSaleOutcome =
  | { status: 'ok'; sale: Sale }
  | { status: 'invalid_source' }
  | { status: 'date_taken' };

export type UpdateSaleOutcome =
  | { status: 'ok'; sale: Sale }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' }
  | { status: 'invalid_source' }
  | { status: 'date_taken' };

export type DeleteSaleOutcome =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

/**
 * Create a draft sale + its lines in one transaction. Pre-checks the daily-close
 * uniqueness (D3) and validates every referenced source is active/same-org (else
 * `invalid_source`, no write); the partial unique index is the backstop (a racing
 * duplicate throws a unique violation the action maps to `date_taken`).
 */
export async function createSale(
  db: TenantClient,
  organizationId: string,
  fields: SaleFields,
  lines: SaleLineInput[],
): Promise<CreateSaleOutcome> {
  if (await activeCloseExists(db, organizationId, fields.saleDate, null)) {
    return { status: 'date_taken' };
  }

  const sources = await lockAndResolveSources(db, organizationId, lines);
  if (!sources.allActive) return { status: 'invalid_source' };

  const [sale] = await db
    .insert(sales)
    .values({ organizationId, saleDate: fields.saleDate, note: fields.note, status: 'draft' })
    .returning();
  if (!sale) throw new Error('Failed to create sale.');

  await insertSaleItems(
    db,
    organizationId,
    sale.id,
    lines,
    sources.recipeNames,
    sources.menuNames,
    sources.ingredientNames,
  );
  return { status: 'ok', sale };
}

/**
 * Replace a DRAFT sale's header + full line set in one transaction. Locks the row,
 * enforces optimistic concurrency (`stale`), refuses a non-draft (`not_editable`),
 * re-checks daily-close uniqueness when the date changed, then revalidates sources.
 */
export async function updateSale(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
  fields: SaleFields,
  lines: SaleLineInput[],
): Promise<UpdateSaleOutcome> {
  const lock = await lockSaleForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return lock;
  if (lock.row.status !== 'draft') return { status: 'not_editable' };

  if (
    fields.saleDate !== lock.row.saleDate &&
    (await activeCloseExists(db, organizationId, fields.saleDate, id))
  ) {
    return { status: 'date_taken' };
  }

  const sources = await lockAndResolveSources(db, organizationId, lines);
  if (!sources.allActive) return { status: 'invalid_source' };

  const [sale] = await db
    .update(sales)
    .set({ saleDate: fields.saleDate, note: fields.note })
    .where(and(eq(sales.organizationId, organizationId), eq(sales.id, id)))
    .returning();
  if (!sale) return { status: 'not_found' };

  await db
    .delete(saleItems)
    .where(and(eq(saleItems.organizationId, organizationId), eq(saleItems.saleId, id)));
  await insertSaleItems(
    db,
    organizationId,
    id,
    lines,
    sources.recipeNames,
    sources.menuNames,
    sources.ingredientNames,
  );

  return { status: 'ok', sale };
}

/** Hard-delete a DRAFT sale; its lines cascade. Posted/void are never deletable. */
export async function deleteSale(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<DeleteSaleOutcome> {
  const lock = await lockSaleForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return lock;
  if (lock.row.status !== 'draft') return { status: 'not_editable' };

  await db.delete(sales).where(and(eq(sales.organizationId, organizationId), eq(sales.id, id)));
  return { status: 'ok' };
}

/** True when a NON-void close already exists for the date (optionally excluding `exceptId`). */
async function activeCloseExists(
  db: TenantClient,
  organizationId: string,
  saleDate: string,
  exceptId: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ id: sales.id })
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, organizationId),
        eq(sales.saleDate, saleDate),
        sql`${sales.status} <> 'void'`,
        exceptId ? sql`${sales.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Lock the sale row FOR UPDATE and enforce the optimistic-concurrency guard. The
 * caller layers the status check on top (there is no soft-delete on sales).
 */
async function lockSaleForUpdate(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<
  { status: 'ok'; row: Sale } | { status: 'not_found' } | { status: 'stale' }
> {
  const [row] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.organizationId, organizationId), eq(sales.id, id)))
    .for('update');
  if (!row) return { status: 'not_found' };
  if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { status: 'stale' };
  return { status: 'ok', row };
}

// ── Lifecycle: post + void ────────────────────────────────────────────────────

export type PostSaleOutcome =
  | {
      status: 'ok';
      sale: Sale;
      alreadyPosted: boolean;
      lineCount: number;
      ingredientCount: number;
      stockMoved: boolean;
      movementCount: number;
      transactionId: string;
    }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_postable' }
  | { status: 'incomplete' }
  | { status: 'tax_rate_required' }
  | { status: 'idempotency_conflict' };

export type VoidSaleOutcome =
  | { status: 'ok'; sale: Sale; alreadyVoided: boolean; reversalCount: number }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_voidable' };

/**
 * `draft → posted` (Sprint 12a). Under the sale row lock + the referenced source
 * locks: requires a configured org tax rate, FREEZES the item names + line/sale
 * totals via tax.ts, writes the single protected income row via the F5 primitive
 * (dedup + conflict), decides `movesStock`, and — when moving stock — explodes the
 * consumption + posts one idempotent F1 OUT movement per ingredient. A shortfall
 * makes `recordMovements` THROW (the action catches it after rollback). All in the
 * caller's `withOrg`.
 *
 *  - an already-posted row is a no-op retry (verifies its income row exists);
 *  - a void/non-draft source → `not_postable`; a stale draft → `stale`;
 *  - a missing/trashed source or component → `incomplete` (no write);
 *  - no configured org rate → `tax_rate_required`; a different prior posting →
 *    `idempotency_conflict`.
 */
export async function postSale(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<PostSaleOutcome> {
  // 1. Lock the sale row.
  const [row] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.organizationId, organizationId), eq(sales.id, id)))
    .for('update');
  if (!row) return { status: 'not_found' };

  // Terminal idempotent retry: an already-posted sale is an ok/no-op once its income
  // row is confirmed present (writes + audits nothing). Checked BEFORE the stale guard.
  if (row.status === 'posted') {
    const txId = await findSaleTransactionId(db, organizationId, id);
    if (!txId) throw new Error(`Posted sale ${id} is missing its income transaction.`);
    return {
      status: 'ok',
      sale: row,
      alreadyPosted: true,
      lineCount: 0,
      ingredientCount: 0,
      stockMoved: row.stockMoved,
      movementCount: 0,
      transactionId: txId,
    };
  }
  if (row.status !== 'draft') return { status: 'not_postable' };

  // 2. Optimistic concurrency on the still-draft row.
  if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { status: 'stale' };

  // 3. Require a configured org tax rate (D5) — no silent 0%.
  const settings = await getOrgSettingsRow(db, organizationId);
  if (settings?.defaultTaxRateBps == null) return { status: 'tax_rate_required' };

  // 4. Load the lines + lock/revalidate the referenced sources.
  const items = await db
    .select()
    .from(saleItems)
    .where(and(eq(saleItems.organizationId, organizationId), eq(saleItems.saleId, id)))
    .orderBy(asc(saleItems.sortOrder));

  const lineInputs: SaleLineInput[] = items.map((i) => ({
    itemKind: i.itemKind,
    itemRecipeId: i.itemRecipeId,
    itemMenuId: i.itemMenuId,
    itemIngredientId: i.itemIngredientId,
    quantity: i.quantity,
    ingredientQtyCanonical:
      i.ingredientQtyCanonical === null ? null : Number(i.ingredientQtyCanonical),
    unitNetCents: i.unitNetCents,
    taxRateBps: i.taxRateBps,
  }));

  const sources = await lockAndResolveSources(db, organizationId, lineInputs);
  if (!sources.allActive) return { status: 'incomplete' };

  // 5. Build the consumption explosion under the locks (re-checked, never trusted).
  const explosion = await buildConsumption(
    db,
    organizationId,
    lineInputs,
    sources.menuNames,
  );
  if (!explosion.complete) return { status: 'incomplete' };

  // Lock the consumed ingredient set (id-asc, the order recordMovements uses) so a
  // racing ingredient trash serializes even on the financial-only path.
  const ingredientIds = explosion.requirements.map((r) => r.ingredientId).sort();
  if (!(await allIngredientsActive(db, organizationId, ingredientIds))) {
    return { status: 'incomplete' };
  }

  // 6. Freeze the sale + line totals from the raw line fields (tax.ts).
  const totals = saleTotals(
    lineInputs.map<TaxLineInput>((l) => ({
      netCents: l.quantity * l.unitNetCents,
      bps: l.taxRateBps,
    })),
  );

  // 7. The single PROTECTED income row (F5). Dedup + conflict, never an overwrite.
  const txResult = await postSaleTransaction(db, organizationId, {
    saleId: id,
    grossCents: totals.grossCents,
    occurredOn: row.saleDate,
  });
  if (!txResult.ok) return { status: 'idempotency_conflict' };

  // 8. Stock-control decision at the sale date, evaluated ONCE (F5).
  const stockMoved = movesStock(row.saleDate, settings.stockControlStartDate ?? null);

  // 9. Post one aggregated OUT movement per ingredient when in stock control.
  //    recordMovements THROWS on a shortfall → whole withOrg rolls back.
  let movementCount = 0;
  if (stockMoved && explosion.requirements.length > 0) {
    const movements: RecordMovementInput[] = explosion.requirements.map((req) => ({
      ingredientId: req.ingredientId,
      deltaCanonical: -req.quantityCanonical,
      source: { type: 'sale', id, lineId: null },
      idempotencyKey: buildMovementKey('sale', id, null, req.ingredientId),
    }));
    await recordMovements(db, organizationId, movements);
    movementCount = movements.length;
  }

  // 10. Re-freeze each line's item_name (source may have been renamed) + totals,
  //     then flip the sale to posted.
  for (const item of items) {
    const name =
      resolveItemNameForItem(item, sources.recipeNames, sources.menuNames, sources.ingredientNames) ??
      item.itemName;
    const money = computeLineMoney({
      quantity: item.quantity,
      unitNetCents: item.unitNetCents,
      taxRateBps: item.taxRateBps,
    });
    await db
      .update(saleItems)
      .set({
        itemName: name,
        netCents: money.netCents,
        taxCents: money.taxCents,
        grossCents: money.grossCents,
      })
      .where(and(eq(saleItems.organizationId, organizationId), eq(saleItems.id, item.id)));
  }

  const [updated] = await db
    .update(sales)
    .set({
      status: 'posted',
      netCents: totals.netCents,
      taxCents: totals.taxCents,
      grossCents: totals.grossCents,
      postedAt: new Date(),
      stockMoved,
    })
    .where(and(eq(sales.organizationId, organizationId), eq(sales.id, id)))
    .returning();
  if (!updated) return { status: 'not_found' };

  return {
    status: 'ok',
    sale: updated,
    alreadyPosted: false,
    lineCount: items.length,
    ingredientCount: explosion.requirements.length,
    stockMoved,
    movementCount,
    transactionId: txResult.transaction.id,
  };
}

/**
 * `posted → void` (Sprint 12a). Soft-deletes the income row (F5 path) and reverses
 * every booked OUT movement (F1) in one transaction; the row is RETAINED as history.
 * A financial-only sale has no movements to reverse. Idempotent: voiding an
 * already-void sale is an ok/no-op (no second reversal, no second audit).
 */
export async function voidSale(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<VoidSaleOutcome> {
  const [row] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.organizationId, organizationId), eq(sales.id, id)))
    .for('update');
  if (!row) return { status: 'not_found' };
  if (row.status === 'void') {
    return { status: 'ok', sale: row, alreadyVoided: true, reversalCount: 0 };
  }
  if (row.status !== 'posted') return { status: 'not_voidable' };
  if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { status: 'stale' };

  // Soft-delete the protected income row (the only allowed path, F5).
  await voidSaleTransaction(db, organizationId, id);

  // Reverse the OUT movements this sale booked (empty for a financial-only sale).
  const outMovements = await db
    .select({
      id: inventoryMovements.id,
      ingredientId: inventoryMovements.ingredientId,
      deltaCanonical: inventoryMovements.deltaCanonical,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.organizationId, organizationId),
        eq(inventoryMovements.sourceType, 'sale'),
        eq(inventoryMovements.sourceId, id),
      ),
    );
  if (outMovements.length > 0) {
    const reversals: RecordMovementInput[] = outMovements.map((m) => ({
      ingredientId: m.ingredientId,
      deltaCanonical: -Number(m.deltaCanonical),
      source: { type: 'reversal', id, lineId: null },
      reversalOf: m.id,
      idempotencyKey: buildMovementKey('reversal', m.id, null, m.ingredientId),
    }));
    await recordMovements(db, organizationId, reversals);
  }

  const [updated] = await db
    .update(sales)
    .set({ status: 'void', voidedAt: new Date() })
    .where(and(eq(sales.organizationId, organizationId), eq(sales.id, id)))
    .returning();
  if (!updated) return { status: 'not_found' };

  return { status: 'ok', sale: updated, alreadyVoided: false, reversalCount: outMovements.length };
}

/** The frozen item_name for a stored line, resolved from the locked source maps. */
function resolveItemNameForItem(
  item: SaleItem,
  recipeNames: Map<string, NameInfo>,
  menuNames: Map<string, NameInfo>,
  ingredientNames: Map<string, NameInfo>,
): string | null {
  if (item.itemKind === 'recipe') return recipeNames.get(item.itemRecipeId ?? '')?.name ?? null;
  if (item.itemKind === 'menu') return menuNames.get(item.itemMenuId ?? '')?.name ?? null;
  return ingredientNames.get(item.itemIngredientId ?? '')?.name ?? null;
}

/** The income transaction id for a sale (any soft-delete state), or null. */
async function findSaleTransactionId(
  db: TenantClient,
  organizationId: string,
  saleId: string,
): Promise<string | null> {
  const [tx] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.sourceType, 'sale'),
        eq(transactions.sourceId, saleId),
      ),
    )
    .limit(1);
  return tx?.id ?? null;
}

/** True when every id resolves to an ACTIVE same-org ingredient (locked id-asc). */
async function allIngredientsActive(
  db: TenantClient,
  organizationId: string,
  ids: string[],
): Promise<boolean> {
  if (ids.length === 0) return true;
  const locked = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        inArray(ingredients.id, ids),
        isNull(ingredients.deletedAt),
      ),
    )
    .orderBy(asc(ingredients.id))
    .for('update');
  return locked.length === ids.length;
}

/**
 * Resolve the consumption explosion for a sale's lines. Loads the recipe explosion
 * info (recipe lines + menu component recipes) and the menu component lists, folds
 * recipe portions across every reference, and delegates the aggregation math +
 * completeness to the pure `explodeSaleConsumption`.
 */
async function buildConsumption(
  db: TenantClient,
  organizationId: string,
  lines: SaleLineInput[],
  menuNames: Map<string, NameInfo>,
) {
  const menuIds = distinct(lines.filter((l) => l.itemMenuId).map((l) => l.itemMenuId!));

  // Menu → component recipes (only active menus expand; trashed/missing are flagged).
  const menuComponents = await loadMenuComponents(db, organizationId, menuIds);
  const unavailableSourceIds: string[] = [];
  for (const menuId of menuIds) {
    if (menuNames.get(menuId)?.available !== true) unavailableSourceIds.push(menuId);
  }

  // Fold recipe portions across recipe lines + menu expansion.
  const portionsByRecipe = new Map<string, number>();
  for (const line of lines) {
    if (line.itemKind === 'recipe' && line.itemRecipeId) {
      portionsByRecipe.set(
        line.itemRecipeId,
        (portionsByRecipe.get(line.itemRecipeId) ?? 0) + line.quantity,
      );
    } else if (line.itemKind === 'menu' && line.itemMenuId) {
      if (menuNames.get(line.itemMenuId)?.available !== true) continue; // trashed → flagged
      const components = menuComponents.get(line.itemMenuId) ?? [];
      for (const comp of components) {
        portionsByRecipe.set(
          comp.recipeId,
          (portionsByRecipe.get(comp.recipeId) ?? 0) + line.quantity * comp.quantity,
        );
      }
    }
  }

  // Recipe explosion info for every referenced recipe (recipe lines + menu components).
  const recipeIds = [...portionsByRecipe.keys()];
  const recipeInfo = await loadRecipeExplosionInfo(db, organizationId, recipeIds);
  const recipeInputs: SaleRecipeInput[] = recipeIds.map((recipeId) => {
    const info = recipeInfo.get(recipeId);
    return {
      recipeId,
      plannedQty: portionsByRecipe.get(recipeId) ?? 0,
      available: info?.available ?? false,
      yieldPortions: info?.yieldPortions ?? 1,
      yieldPercentage: info?.yieldPercentage ?? 100,
      lines: info?.lines ?? [],
    };
  });

  // Direct ingredient lines.
  const directIngredientIds = distinct(
    lines.filter((l) => l.itemIngredientId).map((l) => l.itemIngredientId!),
  );
  const ingredientActive = await loadActiveIds(
    db,
    organizationId,
    ingredients,
    directIngredientIds,
  );
  const ingredientLines: SaleIngredientLine[] = [];
  for (const line of lines) {
    if (line.itemKind !== 'ingredient' || !line.itemIngredientId) continue;
    ingredientLines.push({
      ingredientId: line.itemIngredientId,
      units: line.quantity,
      qtyCanonicalPerUnit: line.ingredientQtyCanonical ?? 0,
      available: ingredientActive.has(line.itemIngredientId),
    });
  }

  return explodeSaleConsumption({
    recipes: recipeInputs,
    ingredientLines,
    unavailableSourceIds,
  });
}

type RecipeExplosionInfo = {
  available: boolean;
  yieldPortions: number;
  yieldPercentage: number;
  lines: { ingredientId: string; quantity: number }[];
};

/** Resolve recipe yield + ingredient lines (incl. trashed → available:false). */
async function loadRecipeExplosionInfo(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, RecipeExplosionInfo>> {
  const map = new Map<string, RecipeExplosionInfo>();
  if (recipeIds.length === 0) return map;

  const recipeRows = await db
    .select({
      id: recipes.id,
      deletedAt: recipes.deletedAt,
      yieldPortions: recipes.yieldPortions,
      yieldPercentage: recipes.yieldPercentage,
    })
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), inArray(recipes.id, recipeIds)));
  for (const r of recipeRows) {
    map.set(r.id, {
      available: r.deletedAt === null,
      yieldPortions: r.yieldPortions,
      yieldPercentage: r.yieldPercentage,
      lines: [],
    });
  }

  const lineRows = await db
    .select({
      recipeId: recipeIngredients.recipeId,
      ingredientId: recipeIngredients.ingredientId,
      quantity: recipeIngredients.quantity,
    })
    .from(recipeIngredients)
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        inArray(recipeIngredients.recipeId, recipeIds),
      ),
    );
  for (const l of lineRows) {
    map.get(l.recipeId)?.lines.push({
      ingredientId: l.ingredientId,
      quantity: Number(l.quantity),
    });
  }
  return map;
}

/** Component recipes (recipeId + portion quantity) for a set of menus. */
async function loadMenuComponents(
  db: TenantClient,
  organizationId: string,
  menuIds: string[],
): Promise<Map<string, { recipeId: string; quantity: number }[]>> {
  const map = new Map<string, { recipeId: string; quantity: number }[]>();
  if (menuIds.length === 0) return map;
  const rows = await db
    .select({
      menuId: menuItems.menuId,
      recipeId: menuItems.recipeId,
      quantity: menuItems.quantity,
    })
    .from(menuItems)
    .where(
      and(eq(menuItems.organizationId, organizationId), inArray(menuItems.menuId, menuIds)),
    );
  for (const r of rows) {
    const list = map.get(r.menuId);
    if (list) list.push({ recipeId: r.recipeId, quantity: r.quantity });
    else map.set(r.menuId, [{ recipeId: r.recipeId, quantity: r.quantity }]);
  }
  return map;
}

// ── Purge-guard counters (Sprint 12a — extend the existing guards) ────────────

/** How many sale_items reference a recipe (any sale status). Purge guard reads first. */
export async function countSalesUsingRecipe(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(saleItems)
    .where(
      and(eq(saleItems.organizationId, organizationId), eq(saleItems.itemRecipeId, recipeId)),
    );
  return rows[0]?.value ?? 0;
}

/** How many sale_items reference a menu (any sale status). Purge guard reads first. */
export async function countSalesUsingMenu(
  db: TenantClient,
  organizationId: string,
  menuId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(saleItems)
    .where(
      and(eq(saleItems.organizationId, organizationId), eq(saleItems.itemMenuId, menuId)),
    );
  return rows[0]?.value ?? 0;
}

/**
 * How many sale lines OR sale-sourced inventory movements reference an ingredient.
 * A non-zero count pins the ingredient from purge (a direct sale line via the
 * restrict FK, or a posted stock-moving sale via the ledger). The ingredient-purge
 * guard reads this BEFORE any side effect.
 */
export async function countSalesUsingIngredient(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<number> {
  const [lineRows, movementRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(saleItems)
      .where(
        and(
          eq(saleItems.organizationId, organizationId),
          eq(saleItems.itemIngredientId, ingredientId),
        ),
      ),
    db
      .select({ value: count() })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.organizationId, organizationId),
          eq(inventoryMovements.ingredientId, ingredientId),
          eq(inventoryMovements.sourceType, 'sale'),
        ),
      ),
  ]);
  return (lineRows[0]?.value ?? 0) + (movementRows[0]?.value ?? 0);
}
