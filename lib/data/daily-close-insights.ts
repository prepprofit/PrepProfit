import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { ingredients, saleItems, sales } from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';
import type { TenantClient } from '@/lib/db/tenant';
import { recipeCost, lineCostCents } from '@/lib/calculations/recipeCost';
import { menuCost } from '@/lib/calculations/menu';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';
import {
  buildDailyCloseInsights,
  type DailyCloseInsights,
  type DailyCloseLineInput,
} from '@/lib/calculations/daily-close-insights';

/**
 * Daily Close Insights data loader (Sprint 6, Slice 6.2). Org-scoped (RULE #1): the
 * sale read, the catalogue read, and the comparable-history read all filter
 * `organization_id`, and the caller runs it inside `withOrg` so RLS is the second layer.
 * A daily close is FINANCIAL → manager-only at the page/action layer; this loader assumes
 * the role check already passed.
 *
 * ONLY a POSTED, same-org close produces insights (plan §11 acceptance): a draft is still
 * being edited and a void was reversed, so both return null — no misleading summary. It
 * joins three things the pure fact module can't see: the close's FROZEN totals/lines, the
 * org's CURRENT catalogue cost (via the same `recipeCost`/`menuCost` engine the recipe
 * editor uses — an unpriced ingredient or an incomplete/trashed source resolves to a null
 * cost, never a flattered one), and the gross takings of COMPARABLE prior closes for the
 * variance baseline. All money/derivation logic lives in the tested pure module; this
 * stays a thin, org-scoped mapper.
 */

/**
 * "Comparable days" = the same weekday within a trailing window, capturing weekly
 * seasonality (a Saturday is compared with other Saturdays, not with Mondays). If fewer
 * than the pure module's minimum survive, no variance is reported.
 */
const VARIANCE_LOOKBACK_DAYS = 56; // 8 weeks
const MAX_COMPARABLE_CLOSES = 8;

function ymdMinusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00.000Z`).getUTCDay();
}

export async function loadDailyCloseInsights(
  db: TenantClient,
  organizationId: string,
  saleId: string,
): Promise<DailyCloseInsights | null> {
  const [sale] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.organizationId, organizationId), eq(sales.id, saleId)))
    .limit(1);
  // Only a posted close can be summarized (a draft/void must not).
  if (!sale || sale.status !== 'posted') return null;

  const items = await db
    .select()
    .from(saleItems)
    .where(and(eq(saleItems.organizationId, organizationId), eq(saleItems.saleId, saleId)))
    .orderBy(asc(saleItems.sortOrder));

  // ── Current catalogue cost: recipe per-portion + menu cost, honest-or-null. ──
  const catalogue = await loadActiveCatalogue(db, organizationId);
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

  // ── Direct-ingredient lines: current per-unit cost from price × canonical qty. ──
  const directIngredientIds = [
    ...new Set(
      items
        .filter((i) => i.itemKind === 'ingredient' && i.itemIngredientId)
        .map((i) => i.itemIngredientId!),
    ),
  ];
  const ingredientCostInfo = new Map<
    string,
    { priceCents: number; dimension: Dimension; needsPricing: boolean }
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
      // A trashed or unpriced ingredient → no honest cost (the map miss yields null).
      if (r.deletedAt !== null || r.needsPricing) continue;
      ingredientCostInfo.set(r.id, {
        priceCents: r.priceCents,
        dimension: r.dimension,
        needsPricing: r.needsPricing,
      });
    }
  }

  const lines: DailyCloseLineInput[] = items.map((item) => {
    let unitCostCents: number | null = null;
    if (item.itemKind === 'recipe' && item.itemRecipeId) {
      unitCostCents = recipeCostPerPortion.get(item.itemRecipeId) ?? null;
    } else if (item.itemKind === 'menu' && item.itemMenuId) {
      unitCostCents = menuCostById.get(item.itemMenuId) ?? null;
    } else if (item.itemKind === 'ingredient' && item.itemIngredientId) {
      const info = ingredientCostInfo.get(item.itemIngredientId);
      const qty = item.ingredientQtyCanonical === null ? null : Number(item.ingredientQtyCanonical);
      unitCostCents =
        info && qty !== null && Number.isFinite(qty)
          ? Math.round(
              lineCostCents({
                dimension: info.dimension,
                priceCents: info.priceCents,
                quantity: qty,
              }),
            )
          : null;
    }
    const refId =
      (item.itemKind === 'recipe'
        ? item.itemRecipeId
        : item.itemKind === 'menu'
          ? item.itemMenuId
          : item.itemIngredientId) ?? item.id;
    return {
      kind: item.itemKind,
      id: refId,
      name: item.itemName,
      unitsSold: item.quantity,
      netCents: item.netCents,
      unitCostCents,
    };
  });

  // ── Comparable closes: same weekday, prior posted closes in the lookback window. ──
  const weekday = weekdayOf(sale.saleDate);
  const lowerBound = ymdMinusDays(sale.saleDate, VARIANCE_LOOKBACK_DAYS);
  const priorCloses = await db
    .select({ saleDate: sales.saleDate, grossCents: sales.grossCents })
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, organizationId),
        eq(sales.status, 'posted'),
        lt(sales.saleDate, sale.saleDate),
        gte(sales.saleDate, lowerBound),
        // Same weekday (ISO date → Postgres dow: 0=Sunday, matching JS getUTCDay).
        sql`extract(dow from ${sales.saleDate}::date) = ${weekday}`,
      ),
    )
    .orderBy(desc(sales.saleDate))
    .limit(MAX_COMPARABLE_CLOSES);

  const comparableGrossCents = priorCloses
    .map((c) => c.grossCents)
    .filter((g): g is number => g !== null);

  return buildDailyCloseInsights({
    saleDate: sale.saleDate,
    grossCents: sale.grossCents ?? 0,
    netCents: sale.netCents ?? 0,
    taxCents: sale.taxCents ?? 0,
    lines,
    comparableGrossCents,
  });
}
