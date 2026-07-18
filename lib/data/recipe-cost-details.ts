import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  ingredientPrepActions,
  ingredientPriceHistory,
  ingredientSuppliers,
  ingredients,
  recipeIngredients,
  suppliers,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { lineCostCents } from '@/lib/calculations/recipeCost';

/**
 * Per-line cost detail for the expandable cost panel (Recipes 2.0 Fase 5,
 * plan §7.3): purchase item, purchase cost, unit, supplier, date and the
 * ORIGIN of the approved price. STRICTLY MANAGER-ONLY — the caller must gate
 * on role before loading; none of this may enter a kitchen payload (the deep
 * key-scan hunts `priceCents`/`supplier`/`lineCostCents` keys).
 *
 * A line whose ingredient `needsPricing` ships `lineCostCents: null` — the UI
 * renders "Needs pricing", never a free 0 (the AGGREGATE tiles keep today's
 * behaviour: frozen fixtures unchanged).
 */

export type RecipeIngredientCostDetail = {
  lineId: string;
  ingredientId: string;
  name: string;
  dimension: 'weight' | 'volume' | 'count';
  /** Canonical amount used (g / ml / count). */
  quantity: number;
  prepName: string | null;
  /** Usable yield of the prep action (bps), when it inflates the cost. */
  prepYieldBps: number | null;
  /** Approved price per canonical purchase unit (per kg / litre / piece). */
  priceCents: number;
  needsPricing: boolean;
  /** Cost of THIS line (prep-yield inflated), or null when unpriced. */
  lineCostCents: number | null;
  /** Default supplier entity name, else the legacy free-text supplier. */
  supplierName: string | null;
  /** Purchase pack of the default supplier link (the "purchase item"). */
  packSize: number | null;
  packUnit: string | null;
  packPriceCents: number | null;
  /** Origin of the approved price: latest ACCEPTED observation. */
  priceSource: 'manual' | 'order' | 'quote' | 'import' | null;
  priceSourceDate: string | null;
};

export async function loadRecipeIngredientCostDetails(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<RecipeIngredientCostDetail[]> {
  const lineRows = await db
    .select({
      lineId: recipeIngredients.id,
      ingredientId: recipeIngredients.ingredientId,
      quantity: recipeIngredients.quantity,
      displaySortOrder: recipeIngredients.displaySortOrder,
      name: ingredients.name,
      dimension: ingredients.dimension,
      priceCents: ingredients.priceCents,
      needsPricing: ingredients.needsPricing,
      legacySupplier: ingredients.supplier,
      prepName: ingredientPrepActions.name,
      prepYieldBps: ingredientPrepActions.yieldBps,
    })
    .from(recipeIngredients)
    .innerJoin(
      ingredients,
      and(
        eq(ingredients.organizationId, recipeIngredients.organizationId),
        eq(ingredients.id, recipeIngredients.ingredientId),
      ),
    )
    .leftJoin(
      ingredientPrepActions,
      and(
        eq(ingredientPrepActions.organizationId, organizationId),
        eq(ingredientPrepActions.id, recipeIngredients.prepActionId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.recipeId, recipeId),
      ),
    )
    .orderBy(recipeIngredients.displaySortOrder);

  const ingredientIds = [...new Set(lineRows.map((r) => r.ingredientId))];
  if (ingredientIds.length === 0) return [];

  const [supplierRows, historyRows] = await Promise.all([
    // The ONE default supplier link per ingredient + its entity name.
    db
      .select({
        ingredientId: ingredientSuppliers.ingredientId,
        packSize: ingredientSuppliers.packSize,
        packUnit: ingredientSuppliers.packUnit,
        packPriceCents: ingredientSuppliers.packPriceCents,
        supplierName: suppliers.name,
      })
      .from(ingredientSuppliers)
      .innerJoin(
        suppliers,
        and(
          eq(suppliers.organizationId, ingredientSuppliers.organizationId),
          eq(suppliers.id, ingredientSuppliers.supplierId),
        ),
      )
      .where(
        and(
          eq(ingredientSuppliers.organizationId, organizationId),
          inArray(ingredientSuppliers.ingredientId, ingredientIds),
          eq(ingredientSuppliers.isDefault, true),
        ),
      ),
    // Latest ACCEPTED observation per ingredient = origin of the approved price.
    db
      .select({
        ingredientId: ingredientPriceHistory.ingredientId,
        source: ingredientPriceHistory.source,
        createdAt: ingredientPriceHistory.createdAt,
      })
      .from(ingredientPriceHistory)
      .where(
        and(
          eq(ingredientPriceHistory.organizationId, organizationId),
          inArray(ingredientPriceHistory.ingredientId, ingredientIds),
          eq(ingredientPriceHistory.accepted, true),
        ),
      )
      .orderBy(desc(ingredientPriceHistory.createdAt)),
  ]);

  const supplierByIngredient = new Map(
    supplierRows.map((r) => [r.ingredientId, r]),
  );
  const originByIngredient = new Map<
    string,
    { source: 'manual' | 'order' | 'quote' | 'import'; createdAt: Date }
  >();
  for (const row of historyRows) {
    // Rows arrive newest-first; keep the first per ingredient.
    if (!originByIngredient.has(row.ingredientId)) {
      originByIngredient.set(row.ingredientId, row);
    }
  }

  return lineRows.map((r) => {
    const quantity = Number(r.quantity);
    const supplier = supplierByIngredient.get(r.ingredientId);
    const origin = originByIngredient.get(r.ingredientId);
    return {
      lineId: r.lineId,
      ingredientId: r.ingredientId,
      name: r.name,
      dimension: r.dimension,
      quantity,
      prepName: r.prepName,
      prepYieldBps: r.prepYieldBps,
      priceCents: r.priceCents,
      needsPricing: r.needsPricing,
      lineCostCents: r.needsPricing
        ? null
        : Math.round(
            lineCostCents({
              dimension: r.dimension,
              priceCents: r.priceCents,
              quantity,
              ...(r.prepYieldBps != null ? { prepYieldBps: r.prepYieldBps } : {}),
            }),
          ),
      supplierName: supplier?.supplierName ?? r.legacySupplier ?? null,
      packSize: supplier?.packSize != null ? Number(supplier.packSize) : null,
      packUnit: supplier?.packUnit ?? null,
      packPriceCents: supplier?.packPriceCents ?? null,
      priceSource: origin?.source ?? null,
      priceSourceDate: origin ? origin.createdAt.toISOString() : null,
    };
  });
}
