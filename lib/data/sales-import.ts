import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ingredients, menus, recipes, sales } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { saleLineTotals, saleTotals } from '@/lib/calculations/tax';
import { movesStock } from '@/lib/finance/stock-control';
import {
  createSale,
  postSale,
  type SaleLineInput,
  type PostSaleOutcome,
} from '@/lib/data/sales';
import { writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import { normalizeSaleItemName, type DraftSaleImportRow } from '@/lib/import/parse';
import type { ParsedRow } from '@/lib/import/parse';
import type { ActionErrorCode } from '@/lib/action-result';
import type {
  ImportSaleClose,
  ImportSaleItemKind,
  ImportSaleLine,
  ImportSalesPayload,
  ImportRowIssue,
} from '@/lib/import/types';

/**
 * DB-dependent sales import PLANNING + APPLY (Sprint 12b). The pure parser
 * (`parseSalesRows`) produces structurally-checked draft lines; planning resolves
 * what only the org's data can decide — exact item resolution (D5), daily-close
 * date dedup (D2), the org tax default, and the stock-control decision — then groups
 * lines into daily closes. Apply creates + posts each importable close through the
 * 12a primitives (`createSale` → `postSale`), so the protected income row and stock
 * movements come ONLY from the shared sale lifecycle, never written here directly.
 *
 * ALWAYS org-scoped (RULE #1); MUST run inside `withOrg` so RLS is active.
 */

export type SalesImportPlan = {
  /** The staged payload (closes grouped by date) for the job + preview. */
  payload: ImportSalesPayload;
  /** Every issue across all closes, flattened for the generic preview list. */
  issues: ImportRowIssue[];
  /** Counts BY CLOSE (not by raw row), for the summary + audit metadata. */
  counts: { total: number; importable: number; skipped: number; invalid: number };
  /** How many importable closes are financial-only (post revenue, no stock OUT). */
  financialOnly: number;
};

/** A typed error thrown from `applySalesImport` so the caller's `withOrg` rolls back. */
export class SalesImportError extends Error {
  constructor(
    public readonly code: ActionErrorCode,
    public readonly saleDate?: string,
  ) {
    super(code);
    this.name = 'SalesImportError';
  }
}

/** Map a non-ok `postSale` status to a stable action error code. */
function postSaleErrorCode(status: Exclude<PostSaleOutcome['status'], 'ok'>): ActionErrorCode {
  switch (status) {
    case 'tax_rate_required':
      return 'SALES_TAX_RATE_REQUIRED';
    case 'incomplete':
      return 'SALE_INCOMPLETE';
    case 'idempotency_conflict':
      return 'IDEMPOTENCY_CONFLICT';
    case 'not_found':
    case 'stale':
    case 'not_postable':
      return 'INVALID_INPUT';
  }
}

/** Build a normalized-name → ids map for an active catalogue kind. */
function nameIndex(rows: { id: string; name: string }[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const key = normalizeSaleItemName(r.name);
    const list = map.get(key);
    if (list) list.push(r.id);
    else map.set(key, [r.id]);
  }
  return map;
}

type Resolution =
  | { ok: true; recipeId: string | null; menuId: string | null; ingredientId: string | null }
  | { ok: false; code: 'UNKNOWN_ITEM' | 'AMBIGUOUS_ITEM' };

/** Exact-only resolution (D5): single active same-kind match links; 0 → unknown, >1 → ambiguous. */
function resolveItem(
  kind: ImportSaleItemKind,
  normName: string,
  indexes: { recipe: Map<string, string[]>; menu: Map<string, string[]>; ingredient: Map<string, string[]> },
): Resolution {
  const matches = indexes[kind].get(normName) ?? [];
  if (matches.length === 0) return { ok: false, code: 'UNKNOWN_ITEM' };
  if (matches.length > 1) return { ok: false, code: 'AMBIGUOUS_ITEM' };
  const id = matches[0]!;
  return {
    ok: true,
    recipeId: kind === 'recipe' ? id : null,
    menuId: kind === 'menu' ? id : null,
    ingredientId: kind === 'ingredient' ? id : null,
  };
}

/**
 * Plan a sales import: resolve item names exact-only, group rows into daily closes,
 * apply the org tax default to blank rates, compute line/close totals, mark
 * duplicate-date closes skipped and any close with a hard line issue invalid, and
 * decide each close's stock mode. No writes.
 */
export async function planSalesImport(
  db: TenantClient,
  organizationId: string,
  parsed: ParsedRow<DraftSaleImportRow>[],
  settings: { defaultTaxRateBps: number; stockControlStartDate: string | null },
): Promise<SalesImportPlan> {
  // Active catalogue per kind → normalized-name index for exact resolution.
  const [recipeRows, menuRows, ingredientRows] = await Promise.all([
    db
      .select({ id: recipes.id, name: recipes.name })
      .from(recipes)
      .where(and(eq(recipes.organizationId, organizationId), isNull(recipes.deletedAt))),
    db
      .select({ id: menus.id, name: menus.name })
      .from(menus)
      .where(and(eq(menus.organizationId, organizationId), isNull(menus.deletedAt))),
    db
      .select({ id: ingredients.id, name: ingredients.name })
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, organizationId), isNull(ingredients.deletedAt))),
  ]);
  const indexes = {
    recipe: nameIndex(recipeRows),
    menu: nameIndex(menuRows),
    ingredient: nameIndex(ingredientRows),
  };

  // Group lines by raw date, preserving first-seen order.
  const groups = new Map<string, { lines: ImportSaleLine[]; issues: ImportRowIssue[] }>();
  const order: string[] = [];

  for (const row of parsed) {
    const draft = row.draft;
    if (!draft) continue; // sales parser always emits a draft for a non-blank row
    const lineIssues: ImportRowIssue[] = [...row.issues];

    let recipeId: string | null = null;
    let menuId: string | null = null;
    let ingredientId: string | null = null;

    // Resolve only when the kind + name are structurally usable.
    if (draft.itemKind !== null && draft.normalizedItemName !== '') {
      const res = resolveItem(draft.itemKind, draft.normalizedItemName, indexes);
      if (res.ok) {
        recipeId = res.recipeId;
        menuId = res.menuId;
        ingredientId = res.ingredientId;
      } else {
        lineIssues.push({ line: row.line, column: 'item_name', code: res.code });
      }
    }

    const bps = draft.taxRateBps ?? settings.defaultTaxRateBps;
    const money = saleLineTotals({ netCents: draft.quantity * draft.unitNetCents, bps });
    const line: ImportSaleLine = {
      sourceLine: row.line,
      itemKind: draft.itemKind,
      itemName: draft.itemName,
      normalizedItemName: draft.normalizedItemName,
      itemRecipeId: recipeId,
      itemMenuId: menuId,
      itemIngredientId: ingredientId,
      quantity: draft.quantity,
      ingredientQtyCanonical: draft.ingredientQtyCanonical,
      unitNetCents: draft.unitNetCents,
      taxRateBps: bps,
      netCents: money.netCents,
      taxCents: money.taxCents,
      grossCents: money.grossCents,
    };

    const key = draft.saleDate;
    let group = groups.get(key);
    if (!group) {
      group = { lines: [], issues: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.lines.push(line);
    group.issues.push(...lineIssues);
  }

  // Which candidate dates already have a non-void sale (D2 dedup backstop).
  const candidateDates = order.filter(
    (d) => dateIsValid(d) && (groups.get(d)?.issues.length ?? 0) === 0,
  );
  const takenDates = await activeSaleDates(db, organizationId, candidateDates);

  const closes: ImportSaleClose[] = [];
  const allIssues: ImportRowIssue[] = [];
  let importable = 0;
  let skipped = 0;
  let invalid = 0;
  let financialOnly = 0;

  for (const date of order) {
    const group = groups.get(date)!;
    const totals = saleTotals(
      group.lines.map((l) => ({ netCents: l.quantity * l.unitNetCents, bps: l.taxRateBps })),
    );
    const stockMode: ImportSaleClose['stockMode'] = movesStock(date, settings.stockControlStartDate)
      ? 'moves_stock'
      : 'financial_only';

    const issues = [...group.issues];
    let status: ImportSaleClose['status'];
    if (issues.length > 0) {
      status = 'invalid';
      invalid += 1;
    } else if (takenDates.has(date)) {
      status = 'skipped';
      issues.push({ line: group.lines[0]?.sourceLine ?? 0, column: 'date', code: 'DUPLICATE' });
      skipped += 1;
    } else {
      status = 'importable';
      importable += 1;
      if (stockMode === 'financial_only') financialOnly += 1;
    }

    allIssues.push(...issues);
    closes.push({
      saleDate: date,
      lines: group.lines,
      netCents: totals.netCents,
      taxCents: totals.taxCents,
      grossCents: totals.grossCents,
      status,
      issues,
      stockMode,
    });
  }

  return {
    payload: { closes },
    issues: allIssues,
    counts: { total: closes.length, importable, skipped, invalid },
    financialOnly,
  };
}

/** True when `date` is a well-formed 'YYYY-MM-DD' string (cheap structural check). */
function dateIsValid(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/** The subset of `dates` that already have a NON-void sale for the org. */
async function activeSaleDates(
  db: TenantClient,
  organizationId: string,
  dates: string[],
): Promise<Set<string>> {
  if (dates.length === 0) return new Set();
  const rows = await db
    .select({ saleDate: sales.saleDate })
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, organizationId),
        inArray(sales.saleDate, dates),
        sql`${sales.status} <> 'void'`,
      ),
    );
  return new Set(rows.map((r) => r.saleDate));
}

export type ApplySalesImportResult = {
  closesCreated: number;
  linesCreated: number;
  movementsCreated: number;
  financialOnly: number;
};

/**
 * Apply the importable closes inside the caller's `withOrg` transaction (D3
 * all-or-nothing): for each close, create a draft sale then immediately post it
 * through the 12a primitives, writing the per-sale `sale.create` / `sale.post`
 * audit events in the SAME transaction (they don't fire from the data functions —
 * senior correction #1). Any failure after the first write THROWS (a typed
 * `SalesImportError`, or a `MovementError` from `recordMovements`) so the whole
 * confirm rolls back. Skipped/invalid closes are ignored.
 */
export async function applySalesImport(
  db: TenantClient,
  organizationId: string,
  actor: AuditActor,
  closes: ImportSaleClose[],
): Promise<ApplySalesImportResult> {
  let closesCreated = 0;
  let linesCreated = 0;
  let movementsCreated = 0;
  let financialOnly = 0;

  for (const close of closes) {
    if (close.status !== 'importable') continue;

    const lines: SaleLineInput[] = close.lines.map((line) => {
      if (line.itemKind === null) {
        // Defense: an importable close should never carry an unresolved line.
        throw new SalesImportError('INVALID_INPUT', close.saleDate);
      }
      return {
        itemKind: line.itemKind,
        itemRecipeId: line.itemRecipeId,
        itemMenuId: line.itemMenuId,
        itemIngredientId: line.itemIngredientId,
        quantity: line.quantity,
        ingredientQtyCanonical: line.ingredientQtyCanonical,
        unitNetCents: line.unitNetCents,
        taxRateBps: line.taxRateBps,
      };
    });

    const created = await createSale(
      db,
      organizationId,
      { saleDate: close.saleDate, note: null },
      lines,
    );
    if (created.status === 'date_taken') {
      throw new SalesImportError('SALE_DATE_TAKEN', close.saleDate);
    }
    if (created.status === 'invalid_source') {
      throw new SalesImportError('SALE_INCOMPLETE', close.saleDate);
    }

    await writeAuditEvent(db, organizationId, actor, {
      action: 'sale.create',
      entityType: 'sale',
      entityId: created.sale.id,
      metadata: { lineCount: lines.length },
    });

    const posted = await postSale(db, organizationId, created.sale.id, created.sale.updatedAt);
    if (posted.status !== 'ok') {
      throw new SalesImportError(postSaleErrorCode(posted.status), close.saleDate);
    }

    await writeAuditEvent(db, organizationId, actor, {
      action: 'sale.post',
      entityType: 'sale',
      entityId: created.sale.id,
      metadata: {
        lineCount: posted.lineCount,
        ingredientCount: posted.ingredientCount,
        stockMoved: posted.stockMoved,
        movementCount: posted.movementCount,
        transactionId: posted.transactionId,
      },
    });

    closesCreated += 1;
    linesCreated += lines.length;
    movementsCreated += posted.movementCount;
    if (!posted.stockMoved) financialOnly += 1;
  }

  return { closesCreated, linesCreated, movementsCreated, financialOnly };
}
