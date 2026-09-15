import { and, eq, inArray } from 'drizzle-orm';
import { ingredientNutritionProfiles } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { AllergenSlug } from '@/lib/allergens/catalog';
import { costPerKgCents, recipeCost } from '@/lib/calculations/recipeCost';
import { marginPercent } from '@/lib/calculations/margin';
import { CORE_NUTRIENT_KEYS } from '@/lib/calculations/nutrition';
import { listRecipes } from '@/lib/data/recipes';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';
import { loadRecipeAllergensByIds } from '@/lib/data/allergens';
import { loadBookIdsByRecipe } from '@/lib/data/recipe-books';
import { loadRecipeFinishedWeights } from '@/lib/data/recipe-yield';
import { compareRecentActivity, recentActivityAt } from '@/lib/recipes/library-order';

/**
 * Recipes 2.0 library listing (Fase 7 Slice 2) — one org-scoped batch read that
 * powers the library TABLE: every active recipe with its books, allergen
 * rollup, honest status flags, and (manager only) money. RULE #1: every query
 * is org-scoped; the caller runs it inside `withOrg` so RLS is the second layer.
 *
 * RBAC: money lives ONLY in the optional `money` key. `toKitchenLibraryRow`
 * strips it — and the financial status flags — from the payload itself, never
 * just the UI (Sprint F4 discipline).
 *
 * Status flags are HONEST APPROXIMATIONS for triage (documented per decision
 * D4): `nutritionIncomplete` is the cheap proxy "some ingredient in the
 * recipe's flattened line set has no nutrition profile"; the exact
 * completeness verdict stays in the workspace's nutrition resolver.
 */

export type LibraryAllergenChip = {
  allergen: AllergenSlug;
  presence: 'contains' | 'may_contain';
};

export type LibraryRecipeRow = {
  id: string;
  name: string;
  /** Legacy folder (D2 coexistence) — drives the folder views of the library. */
  folderId: string | null;
  /** Chef-facing yield ("2.5 kg") when set, else the legacy portions count. */
  yieldQuantity: number | null;
  yieldUnit: string | null;
  yieldPortions: number;
  /** Latest of last edit / last opened (created when neither): the default order. */
  recentActivityAt: Date;
  /** Direct ingredient line count (not the flattened subtree). */
  lineCount: number;
  bookIds: string[];
  /** Effective allergens (derived ∨ override), catalog order. */
  allergens: LibraryAllergenChip[];
  status: {
    /** Some referenced ingredient's allergens were never reviewed. */
    allergensUnreviewed: boolean;
    /** D4 proxy: some ingredient in the (flattened) lines has no nutrition profile. */
    nutritionIncomplete: boolean;
    noBook: boolean;
    /** No finished weight (measured or calculable): cost per kg is unavailable. */
    missingFinishedWeight: boolean;
    /** Yield % was saved under the old model — confirm it in the editor. */
    yieldReviewNeeded: boolean;
  };
  /** Present ONLY on manager payloads. */
  money?: {
    /** Cost per portion, or null when the sub-recipe tree is unresolvable. */
    costPerPortionCents: number | null;
    /**
     * Cost per kg of finished batch — the one figure the browsing list shows. null
     * when it can't be trusted: no finished weight, an unresolvable tree, or an
     * ingredient still missing its price (never a guessed or zero value).
     */
    costPerKgCents: number | null;
    /** Dual-read selling price (default portion option ?? legacy column). */
    sellingPriceCents: number | null;
    /** Margin %, or null when either side is missing. */
    marginPercent: number | null;
    /** Some ingredient in the recipe still needs pricing (cost is understated). */
    needsPricing: boolean;
    /** Labour / energy saved by the old recipe editor, still inside the batch cost. */
    legacyLabourOrEnergy: boolean;
  };
};

/** Kitchen variant: no `money` key at all (typed away, not just undefined). */
export type KitchenLibraryRecipeRow = Omit<LibraryRecipeRow, 'money'>;

export function toKitchenLibraryRow(
  row: LibraryRecipeRow,
): KitchenLibraryRecipeRow {
  const { money: _money, ...operational } = row;
  return operational;
}

export async function listRecipesForLibrary(
  db: TenantClient,
  organizationId: string,
): Promise<LibraryRecipeRow[]> {
  const recipeRows = await listRecipes(db, organizationId);
  if (recipeRows.length === 0) return [];
  const recipeIds = recipeRows.map((r) => r.id);

  const [catalogue, allergenRollups, bookIdsByRecipe, finishedWeights] = await Promise.all([
    loadActiveCatalogue(db, organizationId),
    loadRecipeAllergensByIds(db, organizationId, recipeIds),
    loadBookIdsByRecipe(db, organizationId, recipeIds),
    loadRecipeFinishedWeights(db, organizationId, recipeRows),
  ]);
  const catalogueById = new Map(catalogue.recipes.map((r) => [r.id, r]));
  const needsPricingIngredients = new Set(
    catalogue.ingredients.filter((i) => i.needsPricing).map((i) => i.id),
  );

  // D4 nutrition proxy: which of the ingredients referenced anywhere in the
  // flattened line sets HAVE a (core-complete) profile — one org-scoped query for all of them.
  const referencedIngredientIds = [
    ...new Set(
      catalogue.recipes.flatMap((r) => r.lines.map((l) => l.ingredientId)),
    ),
  ];
  const profiledRows =
    referencedIngredientIds.length === 0
      ? []
      : await db
          .select({
            ingredientId: ingredientNutritionProfiles.ingredientId,
            caloriesKcal: ingredientNutritionProfiles.caloriesKcal,
            totalFatG: ingredientNutritionProfiles.totalFatG,
            totalCarbohydrateG: ingredientNutritionProfiles.totalCarbohydrateG,
            proteinG: ingredientNutritionProfiles.proteinG,
            sodiumMg: ingredientNutritionProfiles.sodiumMg,
          })
          .from(ingredientNutritionProfiles)
          .where(
            and(
              eq(ingredientNutritionProfiles.organizationId, organizationId),
              inArray(
                ingredientNutritionProfiles.ingredientId,
                referencedIngredientIds,
              ),
            ),
          );
  // Only profiles carrying every CORE nutrient count — a partial profile keeps
  // the recipe's label incomplete, exactly like the full rollup.
  const profiledIngredients = new Set(
    profiledRows
      .filter((r) => CORE_NUTRIENT_KEYS.every((k) => r[k] != null))
      .map((r) => r.ingredientId),
  );

  const libraryRows = recipeRows.map((recipe): LibraryRecipeRow => {
    const cat = catalogueById.get(recipe.id);
    const rollup = allergenRollups.get(recipe.id)!;
    const bookIds = bookIdsByRecipe.get(recipe.id) ?? [];

    let costPerPortionCents: number | null = null;
    let totalCostCents: number | null = null;
    if (cat && !cat.costUnresolved) {
      const computed = recipeCost({
        yieldPortions: cat.yieldPortions,
        yieldPercentage: cat.yieldPercentage,
        laborCostCents: cat.laborCostCents,
        energyCostCents: cat.energyCostCents,
        packagingCostCents: cat.packagingCostCents,
        lines: cat.lines.map((l) => ({
          dimension: l.dimension,
          priceCents: l.priceCents,
          quantity: l.quantity,
          prepYieldBps: l.prepYieldBps ?? undefined,
        })),
        componentMaterialCostsCents: [cat.componentHiddenCostCents],
      });
      costPerPortionCents = computed.costPerPortionCents;
      totalCostCents = computed.totalCostCents;
    }
    const needsPricing = cat
      ? cat.lines.some((l) => needsPricingIngredients.has(l.ingredientId))
      : false;
    const sellingPriceCents = cat?.sellingPriceCents ?? null;

    return {
      id: recipe.id,
      name: recipe.name,
      folderId: recipe.folderId,
      yieldQuantity: recipe.yieldQuantity,
      yieldUnit: recipe.yieldUnit,
      yieldPortions: recipe.yieldPortions,
      recentActivityAt: recentActivityAt(recipe),
      lineCount: cat ? new Set(cat.lines.map((l) => l.ingredientId)).size : 0,
      bookIds,
      allergens: rollup.allergens.map((a) => ({
        allergen: a.allergen,
        presence: a.effectivePresence,
      })),
      status: {
        allergensUnreviewed: rollup.hasUnreviewedIngredient,
        nutritionIncomplete:
          !cat ||
          cat.lines.some((l) => !profiledIngredients.has(l.ingredientId)),
        noBook: bookIds.length === 0,
        missingFinishedWeight: finishedWeights.get(recipe.id) == null,
        yieldReviewNeeded: recipe.yieldReviewNeeded,
      },
      money: {
        costPerPortionCents,
        costPerKgCents:
          totalCostCents !== null && !needsPricing
            ? costPerKgCents(totalCostCents, finishedWeights.get(recipe.id) ?? null)
            : null,
        sellingPriceCents,
        marginPercent:
          costPerPortionCents != null &&
          sellingPriceCents != null &&
          sellingPriceCents > 0
            ? marginPercent(costPerPortionCents, sellingPriceCents)
            : null,
        needsPricing,
        legacyLabourOrEnergy: recipe.laborCostCents > 0 || recipe.energyCostCents > 0,
      },
    };
  });
  // Recent activity first — the library's default order in every view.
  return libraryRows.sort(compareRecentActivity);
}
