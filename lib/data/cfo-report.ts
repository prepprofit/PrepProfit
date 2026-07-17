import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { ingredients, saleItems, sales } from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';
import type { TenantClient } from '@/lib/db/tenant';
import { recipeCost, lineCostCents } from '@/lib/calculations/recipeCost';
import { menuCost } from '@/lib/calculations/menu';
import { listIngredients } from '@/lib/data/ingredients';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';
import {
  detectProfitLeaks,
  type ProfitLeakInput,
} from '@/lib/calculations/profit-leaks';
import {
  buildCfoReport,
  type CfoReport,
  type CfoWeeklyTotals,
} from '@/lib/calculations/cfo-report';

/**
 * Weekly CFO Report data loader (Sprint 8, Slice 8.2). Org-scoped (RULE #1): the catalogue
 * read, the two-week sales aggregation, and the stock read all filter `organization_id`, and
 * the caller runs it inside `withOrg` so RLS is the second layer. The CFO report is FINANCIAL
 * → manager-only at the page/action layer; this loader assumes the role check already passed.
 *
 * It joins the things the pure report can't see and hands them to the tested pure module
 * ({@link buildCfoReport}) — no trend or money math lives here:
 *   - the org's CURRENT catalogue cost (via the same `recipeCost`/`menuCost` engine the recipe
 *     editor uses, so an unpriced ingredient or incomplete menu resolves to a null cost, never
 *     a flattered one), which feeds both the deterministic margin leaks and the weekly food
 *     cost;
 *   - the POSTED sale totals of THIS week and the PRIOR week (draft/void excluded) for the
 *     revenue + food-cost trends;
 *   - pending supplier price observations (from the invoice reader) and low-stock ingredients
 *     from the ledger.
 */

/** The report week is the 7 days ending on (and including) `weekTo`. */
const WEEK_DAYS = 7;

function ymdMinusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Today (UTC) as bare 'YYYY-MM-DD' — the default week-ending date. */
export function defaultCfoWeekTo(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

type WeekBucket = 'this' | 'prior';

export async function loadCfoReport(
  db: TenantClient,
  organizationId: string,
  weekTo: string,
): Promise<CfoReport> {
  const weekFrom = ymdMinusDays(weekTo, WEEK_DAYS - 1); // inclusive 7-day window
  // Prior week spans [priorFrom, weekFrom); a header before `weekFrom` buckets to prior.
  const priorFrom = ymdMinusDays(weekTo, WEEK_DAYS * 2 - 1);

  const catalogue = await loadActiveCatalogue(db, organizationId);

  // ── Current catalogue cost: recipe per-portion + menu cost, honest-or-null. ──
  const needsPricingIngredientIds = new Set(
    catalogue.ingredients.filter((i) => i.needsPricing).map((i) => i.id),
  );
  const recipeCostPerPortion = new Map<string, number | null>();
  for (const recipe of catalogue.recipes) {
    const unpriced = recipe.lines.some((l) =>
      needsPricingIngredientIds.has(l.ingredientId),
    );
    const cost = recipeCost({
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      laborCostCents: recipe.laborCostCents,
      energyCostCents: recipe.energyCostCents,
      packagingCostCents: recipe.packagingCostCents,
      lines: recipe.lines.map((l) => ({
        dimension: l.dimension,
        priceCents: l.priceCents,
        quantity: l.quantity,
        prepYieldBps: l.prepYieldBps ?? undefined,
      })),
      componentMaterialCostsCents: [recipe.componentHiddenCostCents],
    });
    recipeCostPerPortion.set(
      recipe.id,
      unpriced || recipe.costUnresolved ? null : cost.costPerPortionCents,
    );
  }
  const menuCostById = new Map<string, number | null>();
  for (const menu of catalogue.menus) {
    const cost = menuCost(
      menu.lines.map((line) => ({
        recipeId: line.recipeId,
        quantity: line.quantity,
        costPerPortionCents: recipeCostPerPortion.get(line.recipeId) ?? null,
      })),
    );
    menuCostById.set(menu.id, cost.complete ? cost.costCents : null);
  }

  // ── Deterministic catalogue findings (margin leaks + reprice candidates). ──
  const leakInput: ProfitLeakInput = {
    ingredients: catalogue.ingredients,
    recipes: catalogue.recipes.map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      sellingPriceCents: recipe.sellingPriceCents,
      cost: {
        yieldPortions: recipe.yieldPortions,
        yieldPercentage: recipe.yieldPercentage,
        laborCostCents: recipe.laborCostCents,
        energyCostCents: recipe.energyCostCents,
        packagingCostCents: recipe.packagingCostCents,
        lines: recipe.lines.map((l) => ({
          dimension: l.dimension,
          priceCents: l.priceCents,
          quantity: l.quantity,
          prepYieldBps: l.prepYieldBps ?? undefined,
        })),
        componentMaterialCostsCents: [recipe.componentHiddenCostCents],
      },
      ingredientIds: [...new Set(recipe.lines.map((l) => l.ingredientId))],
      costUnresolved: recipe.costUnresolved,
    })),
    menus: catalogue.menus,
  };
  const marginLeaks = detectProfitLeaks(leakInput);

  // Confidence inputs derived from the same findings/costs (no fabrication).
  const unpricedIngredientCount = new Set(
    marginLeaks
      .filter(
        (f) =>
          f.type === 'UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE' ||
          f.type === 'UNPRICED_INGREDIENT_IN_ACTIVE_MENU',
      )
      .map((f) => f.entityId),
  ).size;
  const incompleteMenuCount = catalogue.menus.filter(
    (m) => m.lines.length > 0 && menuCostById.get(m.id) == null,
  ).length;

  // ── Supplier price changes: a pending observation that differs from the approved price. ──
  const supplierPriceChanges = catalogue.ingredients
    .filter((i) => i.pendingPriceCents != null && i.pendingPriceCents !== i.priceCents)
    .map((i) => ({
      ingredientId: i.id,
      name: i.name,
      fromCents: i.priceCents,
      toCents: i.pendingPriceCents as number,
    }));

  // ── Two-week posted-sale aggregation (headers for totals + lines for food cost). ──
  const headers = await db
    .select({
      id: sales.id,
      saleDate: sales.saleDate,
      grossCents: sales.grossCents,
      netCents: sales.netCents,
    })
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, organizationId),
        eq(sales.status, 'posted'),
        gte(sales.saleDate, priorFrom),
        lte(sales.saleDate, weekTo),
      ),
    );

  const bucketBySaleId = new Map<string, WeekBucket>();
  const thisWeekAccum = newAccum();
  const priorWeekAccum = newAccum();
  for (const h of headers) {
    const bucket: WeekBucket = h.saleDate >= weekFrom ? 'this' : 'prior';
    bucketBySaleId.set(h.id, bucket);
    const accum = bucket === 'this' ? thisWeekAccum : priorWeekAccum;
    accum.closeCount += 1;
    accum.grossCents += h.grossCents ?? 0;
    accum.netCents += h.netCents ?? 0;
  }

  const lineRows =
    headers.length === 0
      ? []
      : await db
          .select({
            saleId: saleItems.saleId,
            itemKind: saleItems.itemKind,
            itemRecipeId: saleItems.itemRecipeId,
            itemMenuId: saleItems.itemMenuId,
            itemIngredientId: saleItems.itemIngredientId,
            quantity: saleItems.quantity,
            ingredientQtyCanonical: saleItems.ingredientQtyCanonical,
          })
          .from(saleItems)
          .where(
            and(
              eq(saleItems.organizationId, organizationId),
              inArray(
                saleItems.saleId,
                headers.map((h) => h.id),
              ),
            ),
          );

  // Direct-ingredient line cost needs the current approved price + dimension (skip trashed
  // or unpriced ingredients — those lines resolve to null, marking the week partial).
  const directIngredientIds = [
    ...new Set(
      lineRows
        .filter((l) => l.itemKind === 'ingredient' && l.itemIngredientId)
        .map((l) => l.itemIngredientId as string),
    ),
  ];
  const ingredientCostInfo = new Map<
    string,
    { priceCents: number; dimension: Dimension }
  >();
  if (directIngredientIds.length > 0) {
    const rows = await db
      .select({
        id: ingredients.id,
        priceCents: ingredients.priceCents,
        dimension: ingredients.dimension,
        needsPricing: ingredients.needsPricing,
        deletedAt: ingredients.deletedAt,
      })
      .from(ingredients)
      .where(
        and(
          eq(ingredients.organizationId, organizationId),
          inArray(ingredients.id, directIngredientIds),
        ),
      );
    for (const r of rows) {
      if (r.deletedAt !== null || r.needsPricing) continue;
      ingredientCostInfo.set(r.id, { priceCents: r.priceCents, dimension: r.dimension });
    }
  }

  for (const line of lineRows) {
    const bucket = bucketBySaleId.get(line.saleId);
    if (!bucket) continue;
    const accum = bucket === 'this' ? thisWeekAccum : priorWeekAccum;
    const unitCost = unitCostForLine(line, recipeCostPerPortion, menuCostById, ingredientCostInfo);
    if (unitCost == null) {
      accum.costComplete = false;
      continue;
    }
    accum.anyCosted = true;
    accum.foodCostCents += unitCost * line.quantity;
  }

  // ── Low stock: active ingredients at/below their reorder threshold. ──
  const ingredientRows = await listIngredients(db, organizationId);
  const lowStock = ingredientRows
    .map((i) => ({
      ingredientId: i.id,
      name: i.name,
      dimension: i.dimension,
      onHandCanonical: Number(i.stockQuantity),
      thresholdCanonical: i.lowStockThreshold == null ? null : Number(i.lowStockThreshold),
    }))
    .filter(
      (i): i is typeof i & { thresholdCanonical: number } =>
        i.thresholdCanonical != null &&
        i.thresholdCanonical > 0 &&
        Number.isFinite(i.onHandCanonical) &&
        i.onHandCanonical <= i.thresholdCanonical,
    );

  return buildCfoReport({
    weekFrom,
    weekTo,
    thisWeek: finalizeAccum(thisWeekAccum),
    priorWeek: finalizeAccum(priorWeekAccum),
    marginLeaks,
    supplierPriceChanges,
    lowStock,
    unpricedIngredientCount,
    incompleteMenuCount,
  });
}

type WeekAccum = {
  closeCount: number;
  grossCents: number;
  netCents: number;
  foodCostCents: number;
  anyCosted: boolean;
  costComplete: boolean;
};

function newAccum(): WeekAccum {
  return {
    closeCount: 0,
    grossCents: 0,
    netCents: 0,
    foodCostCents: 0,
    anyCosted: false,
    costComplete: true,
  };
}

function finalizeAccum(accum: WeekAccum): CfoWeeklyTotals {
  return {
    grossCents: accum.grossCents,
    netCents: accum.netCents,
    foodCostCents: accum.anyCosted ? Math.round(accum.foodCostCents) : null,
    costComplete: accum.costComplete,
    closeCount: accum.closeCount,
  };
}

/** Current per-unit cost for one posted sale line, or null when it can't be resolved. */
function unitCostForLine(
  line: {
    itemKind: 'recipe' | 'menu' | 'ingredient';
    itemRecipeId: string | null;
    itemMenuId: string | null;
    itemIngredientId: string | null;
    ingredientQtyCanonical: string | null;
  },
  recipeCostPerPortion: Map<string, number | null>,
  menuCostById: Map<string, number | null>,
  ingredientCostInfo: Map<string, { priceCents: number; dimension: Dimension }>,
): number | null {
  if (line.itemKind === 'recipe' && line.itemRecipeId) {
    return recipeCostPerPortion.get(line.itemRecipeId) ?? null;
  }
  if (line.itemKind === 'menu' && line.itemMenuId) {
    return menuCostById.get(line.itemMenuId) ?? null;
  }
  if (line.itemKind === 'ingredient' && line.itemIngredientId) {
    const info = ingredientCostInfo.get(line.itemIngredientId);
    const qty =
      line.ingredientQtyCanonical === null ? null : Number(line.ingredientQtyCanonical);
    if (!info || qty === null || !Number.isFinite(qty)) return null;
    return Math.round(
      lineCostCents({ dimension: info.dimension, priceCents: info.priceCents, quantity: qty }),
    );
  }
  return null;
}
