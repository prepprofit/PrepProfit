import { and, eq, isNull, sql } from 'drizzle-orm';
import { profitSettings, recipes, type ProfitSettings } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { recipeCost } from '@/lib/calculations/recipeCost';
import type { HourlyRateInput } from '@/lib/calculations/profit-hour';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';
import {
  loadDefaultPortionPrices,
  syncLegacyPriceToDefaultOption,
} from '@/lib/data/recipe-portion-options';
import type { ProfitMissing, ProfitProduct } from '@/lib/profit/product';
import type { ProductProfitFormInput, ProfitSettingsInput } from '@/lib/validation/profit';

/**
 * Profit section (Hour Engine) data layer. ALWAYS org-scoped (RULE #1); callers
 * run it inside `withOrg` so RLS is the second layer. FINANCIAL → the page/action
 * layer is manager-only; these helpers assume that check passed. All money and
 * verdict logic lives in the pure `lib/calculations/profit-hour.ts`.
 */

export async function getProfitSettingsRow(
  db: TenantClient,
  organizationId: string,
): Promise<ProfitSettings | null> {
  const rows = await db
    .select()
    .from(profitSettings)
    .where(eq(profitSettings.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertProfitSettings(
  db: TenantClient,
  organizationId: string,
  input: ProfitSettingsInput,
): Promise<ProfitSettings> {
  const [row] = await db
    .insert(profitSettings)
    .values({ organizationId, ...input })
    .onConflictDoUpdate({
      target: profitSettings.organizationId,
      // `$onUpdate` only fires on .update(), not on upsert — stamp it here.
      set: { ...input, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('Failed to save profit settings.');
  return row;
}

/** Settings row → pure-module input; null until productive hours are configured. */
export function toHourlyRateInput(row: ProfitSettings | null): HourlyRateInput | null {
  if (!row || row.productiveHoursPerMonth == null) return null;
  return {
    fixedCostsCents: {
      rent: row.rentCents,
      equipmentLeases: row.equipmentLeasesCents,
      equipmentDepreciation: row.equipmentDepreciationCents,
      insuranceLicenses: row.insuranceLicensesCents,
      utilities: row.utilitiesCents,
      salariedStaff: row.salariedStaffCents,
      software: row.softwareCents,
    },
    productiveHoursPerMonth: row.productiveHoursPerMonth,
    ownerTargetIncomePerHourCents: row.ownerTargetIncomePerHourCents,
    subletEnabled: row.subletEnabled,
    subletIngredientMultiplierBps: row.subletIngredientMultiplierBps,
  };
}

/**
 * The org's active recipes as profit products. Ingredient cost comes from the same
 * engine as the recipe editor (sub-recipes flattened); a recipe with an unpriced
 * ingredient or an unresolvable component gets a null cost, never a flattering one.
 */
export async function loadProfitProducts(
  db: TenantClient,
  organizationId: string,
): Promise<ProfitProduct[]> {
  const [catalogue, profitRows] = await Promise.all([
    loadActiveCatalogue(db, organizationId),
    db
      .select({
        id: recipes.id,
        batchTimeMinutes: recipes.batchTimeMinutes,
        saleUnit: recipes.saleUnit,
        wasteBps: recipes.wasteBps,
        deliveryPerUnitCents: recipes.deliveryPerUnitCents,
        extraStepMinutes: recipes.extraStepMinutes,
        extraStepPriceCents: recipes.extraStepPriceCents,
      })
      .from(recipes)
      .where(and(eq(recipes.organizationId, organizationId), isNull(recipes.deletedAt))),
  ]);

  const profitById = new Map(profitRows.map((r) => [r.id, r]));
  const needsPricing = new Set(
    catalogue.ingredients.filter((i) => i.needsPricing).map((i) => i.id),
  );

  const products: ProfitProduct[] = [];
  for (const recipe of catalogue.recipes) {
    const extra = profitById.get(recipe.id);
    if (!extra) continue;
    const unpriced =
      recipe.costUnresolved || recipe.lines.some((l) => needsPricing.has(l.ingredientId));
    // Hidden costs are fed as zero: packaging/energy are applied per unit by the
    // Hour Engine and labor is replaced by time × true hourly rate.
    const cost = recipeCost({
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      laborCostCents: 0,
      energyCostCents: 0,
      packagingCostCents: 0,
      lines: recipe.lines.map((l) => ({
        dimension: l.dimension,
        priceCents: l.priceCents,
        quantity: l.quantity,
        prepYieldBps: l.prepYieldBps ?? undefined,
      })),
      componentMaterialCostsCents: [recipe.componentHiddenCostCents],
    });

    const missing: ProfitMissing[] = [];
    if (extra.batchTimeMinutes == null) missing.push('batchTime');
    if (recipe.sellingPriceCents == null) missing.push('price');
    if (unpriced) missing.push('ingredientPricing');

    products.push({
      id: recipe.id,
      name: recipe.name,
      saleUnit: extra.saleUnit,
      batchTimeMinutes: extra.batchTimeMinutes,
      batchYield: recipe.yieldPortions,
      sellingPriceCents: recipe.sellingPriceCents,
      ingredientCostPerBatchCents: unpriced ? null : cost.ingredientCostCents,
      packagingPerBatchCents: recipe.packagingCostCents,
      energyPerBatchCents: recipe.energyCostCents,
      deliveryPerUnitCents: extra.deliveryPerUnitCents,
      wasteBps: extra.wasteBps,
      extraStepMinutes: extra.extraStepMinutes,
      extraStepPriceCents: extra.extraStepPriceCents,
      missing,
    });
  }
  return products;
}

export type UpdateProductProfitResult =
  | { status: 'done'; changedFields: string[]; priceChanged: boolean }
  | { status: 'not_found' };

/**
 * Saves a product's Hour Engine inputs. The batch yield and per-batch packaging /
 * energy are the recipe's existing columns, so the recipe `version` is bumped —
 * an open Recipes 2.0 workspace then sees a conflict instead of silently
 * overwriting. A CHANGED price is written to the authoritative default portion
 * option (and the legacy column), exactly like the legacy editor.
 */
export async function updateProductProfit(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  input: ProductProfitFormInput,
): Promise<UpdateProductProfitResult> {
  const scope = and(
    eq(recipes.organizationId, organizationId),
    eq(recipes.id, recipeId),
    isNull(recipes.deletedAt),
  );
  const [before] = await db
    .select({
      batchTimeMinutes: recipes.batchTimeMinutes,
      yieldPortions: recipes.yieldPortions,
      saleUnit: recipes.saleUnit,
      packagingCostCents: recipes.packagingCostCents,
      energyCostCents: recipes.energyCostCents,
      deliveryPerUnitCents: recipes.deliveryPerUnitCents,
      wasteBps: recipes.wasteBps,
      extraStepMinutes: recipes.extraStepMinutes,
      extraStepPriceCents: recipes.extraStepPriceCents,
    })
    .from(recipes)
    .where(scope)
    .for('update')
    .limit(1);
  if (!before) return { status: 'not_found' };

  const next = {
    batchTimeMinutes: input.batchTimeMinutes,
    yieldPortions: input.batchYield,
    saleUnit: input.saleUnit,
    packagingCostCents: input.packagingPerBatchCents,
    energyCostCents: input.energyPerBatchCents,
    deliveryPerUnitCents: input.deliveryPerUnitCents,
    wasteBps: input.wasteBps,
    extraStepMinutes: input.extraStepMinutes,
    extraStepPriceCents: input.extraStepPriceCents,
  };
  const changedFields = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => next[key] !== before[key],
  );

  const prices = await loadDefaultPortionPrices(db, organizationId, [recipeId]);
  const priceChanged = (prices.get(recipeId) ?? null) !== input.sellingPriceCents;

  if (changedFields.length === 0 && !priceChanged) {
    return { status: 'done', changedFields, priceChanged };
  }

  await db
    .update(recipes)
    .set({
      ...next,
      ...(priceChanged ? { sellingPriceCents: input.sellingPriceCents } : {}),
      version: sql`${recipes.version} + 1`,
    })
    .where(scope);

  if (priceChanged) {
    await syncLegacyPriceToDefaultOption(db, organizationId, recipeId, input.sellingPriceCents);
  }
  return { status: 'done', changedFields, priceChanged };
}
