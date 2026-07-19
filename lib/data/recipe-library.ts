import { and, eq, inArray } from 'drizzle-orm';
import { ingredientNutritionProfiles } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { AllergenSlug } from '@/lib/allergens/catalog';
import { recipeCost } from '@/lib/calculations/recipeCost';
import { marginPercent } from '@/lib/calculations/margin';
import { listRecipes } from '@/lib/data/recipes';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';
import { loadRecipeAllergensByIds } from '@/lib/data/allergens';
import { loadBookIdsByRecipe } from '@/lib/data/recipe-books';

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
  };
  /** Present ONLY on manager payloads. */
  money?: {
    /** Cost per portion, or null when the sub-recipe tree is unresolvable. */
    costPerPortionCents: number | null;
    /** Dual-read selling price (default portion option ?? legacy column). */
    sellingPriceCents: number | null;
    /** Margin %, or null when either side is missing. */
    marginPercent: number | null;
    /** Some ingredient in the recipe still needs pricing (cost is understated). */
    needsPricing: boolean;
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

  const [catalogue, allergenRollups, bookIdsByRecipe] = await Promise.all([
    loadActiveCatalogue(db, organizationId),
    loadRecipeAllergensByIds(db, organizationId, recipeIds),
    loadBookIdsByRecipe(db, organizationId, recipeIds),
  ]);
  const catalogueById = new Map(catalogue.recipes.map((r) => [r.id, r]));
  const needsPricingIngredients = new Set(
    catalogue.ingredients.filter((i) => i.needsPricing).map((i) => i.id),
  );

  // D4 nutrition proxy: which of the ingredients referenced anywhere in the
  // flattened line sets HAVE a profile — one org-scoped query for all of them.
  const referencedIngredientIds = [
    ...new Set(
      catalogue.recipes.flatMap((r) => r.lines.map((l) => l.ingredientId)),
    ),
  ];
  const profiledRows =
    referencedIngredientIds.length === 0
      ? []
      : await db
          .select({ ingredientId: ingredientNutritionProfiles.ingredientId })
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
  const profiledIngredients = new Set(profiledRows.map((r) => r.ingredientId));

  return recipeRows.map((recipe) => {
    const cat = catalogueById.get(recipe.id);
    const rollup = allergenRollups.get(recipe.id)!;
    const bookIds = bookIdsByRecipe.get(recipe.id) ?? [];

    let costPerPortionCents: number | null = null;
    if (cat && !cat.costUnresolved) {
      costPerPortionCents = recipeCost({
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
      }).costPerPortionCents;
    }
    const sellingPriceCents = cat?.sellingPriceCents ?? null;

    return {
      id: recipe.id,
      name: recipe.name,
      folderId: recipe.folderId,
      yieldQuantity: recipe.yieldQuantity,
      yieldUnit: recipe.yieldUnit,
      yieldPortions: recipe.yieldPortions,
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
      },
      money: {
        costPerPortionCents,
        sellingPriceCents,
        marginPercent:
          costPerPortionCents != null &&
          sellingPriceCents != null &&
          sellingPriceCents > 0
            ? marginPercent(costPerPortionCents, sellingPriceCents)
            : null,
        needsPricing: cat
          ? cat.lines.some((l) => needsPricingIngredients.has(l.ingredientId))
          : false,
      },
    };
  });
}
