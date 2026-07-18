import { and, eq, inArray } from 'drizzle-orm';

import {
  ingredientPrepActions,
  ingredients,
  ingredientUomEquivalencies,
  recipeComponents,
  recipeIngredients,
  recipePortionOptions,
  recipes,
} from '@/lib/db/schema';
import type { Recipe } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { MAX_COMPONENT_DEPTH } from '@/lib/calculations/production';
import {
  nutritionServingFraction,
  recipeNutrition,
  type NutrientKey,
  type NutritionComponent,
  type NutritionLine,
  type RecipeNutritionResult,
} from '@/lib/calculations/nutrition';
import { convertQuantity, type UomAnchors } from '@/lib/calculations/uom';
import { CANONICAL_UNIT } from '@/lib/calculations/uom';
import { getProfilesForIngredients } from '@/lib/data/ingredient-nutrition';

/**
 * THE shared recipe-nutrition resolver (Fase 6, plan §7.4) — the nutrition twin
 * of `resolveRecipeCostTree`, and deliberately the same shape: one bounded
 * closure walk over `recipe_components`, batch loads for the whole closure
 * (recipes, lines+ingredients+prep, equivalencies, profiles — never N+1), then
 * a memoized bottom-up rollup via the pure `recipeNutrition`.
 *
 * Line weight: a line's `quantity` is canonical in the ingredient's dimension
 * and already the EDIBLE amount (mirroring `recipeCost`); weight lines are
 * grams directly, volume/count lines convert through the ingredient's UoM
 * equivalency (prep anchors override, §7.2) — a missing anchor is an honest
 * `NO_WEIGHT_EQUIVALENCY`, never a guessed density.
 *
 * Serving: children roll up as BATCH totals (`servingFraction: 1`); only the
 * requested recipes get their real nutrition serving applied, resolved from
 * the `is_nutrition_serving` portion option, falling back to the recipe's
 * legacy `nutrition_serving_*` columns.
 */

export type NutritionLineView = {
  ingredientId: string;
  ingredientName: string;
  /** Resolved edible weight in grams, or null when not derivable. */
  edibleWeightGrams: number | null;
  /** Profile provenance for the §9.6 table; null = no profile yet. */
  profile: {
    source: 'usda' | 'custom';
    sourceDescription: string | null;
    brandOwner: string | null;
    fdcId: number | null;
    refreshedAt: Date | null;
    /** Per-100 g values — prefills the custom form in the edit dialog. */
    values: Record<NutrientKey, number | null>;
  } | null;
};

export type RecipeNutritionResolution = {
  result: RecipeNutritionResult;
  /** One row per DIRECT ingredient line occurrence, in display order. */
  lines: NutritionLineView[];
  /** Serving weight in grams when derivable (label header), else null. */
  servingGrams: number | null;
};

type ComponentEdge = {
  id: string;
  recipeId: string;
  componentRecipeId: string;
  quantityGrams: number;
};

function anchorsOf(row: {
  weightGrams: number | null;
  volumeMl: number | null;
  eachCount: number | null;
}): UomAnchors {
  return {
    weightGrams: row.weightGrams,
    volumeMl: row.volumeMl,
    eachCount: row.eachCount,
  };
}

export async function resolveRecipeNutritionTree(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, RecipeNutritionResolution>> {
  const result = new Map<string, RecipeNutritionResolution>();
  const requested = [...new Set(recipeIds)];
  if (requested.length === 0) return result;

  // ── 1. closure over recipe_components (breadth-first, bounded) ──────────────
  const closure = new Set<string>(requested);
  let frontier = requested;
  const edges: ComponentEdge[] = [];
  for (let level = 0; frontier.length > 0 && level <= MAX_COMPONENT_DEPTH + 1; level += 1) {
    const rows = await db
      .select({
        id: recipeComponents.id,
        recipeId: recipeComponents.recipeId,
        componentRecipeId: recipeComponents.componentRecipeId,
        quantityGrams: recipeComponents.quantityGrams,
      })
      .from(recipeComponents)
      .where(
        and(
          eq(recipeComponents.organizationId, organizationId),
          inArray(recipeComponents.recipeId, frontier),
        ),
      );
    edges.push(...rows);
    const next = new Set<string>();
    for (const row of rows) {
      if (!closure.has(row.componentRecipeId)) {
        closure.add(row.componentRecipeId);
        next.add(row.componentRecipeId);
      }
    }
    frontier = [...next];
  }

  // ── 2. batch-load everything for the whole closure ──────────────────────────
  const closureIds = [...closure];
  const [recipeRows, lineRows, servingOptions] = await Promise.all([
    db
      .select()
      .from(recipes)
      .where(
        and(
          eq(recipes.organizationId, organizationId),
          inArray(recipes.id, closureIds),
        ),
      ),
    db
      .select({
        recipeId: recipeIngredients.recipeId,
        displaySortOrder: recipeIngredients.displaySortOrder,
        quantity: recipeIngredients.quantity,
        ingredientId: ingredients.id,
        ingredientName: ingredients.name,
        dimension: ingredients.dimension,
        // The line's prep action may override the base equivalency (§7.2).
        prepWeightGrams: ingredientPrepActions.weightGrams,
        prepVolumeMl: ingredientPrepActions.volumeMl,
        prepEachCount: ingredientPrepActions.eachCount,
        prepId: ingredientPrepActions.id,
      })
      .from(recipeIngredients)
      // Join NOT deleted_at-filtered (mirrors the cost tree): a trashed
      // ingredient still contributes to an existing recipe's rollup.
      .innerJoin(
        ingredients,
        and(
          eq(recipeIngredients.ingredientId, ingredients.id),
          eq(ingredients.organizationId, organizationId),
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
          inArray(recipeIngredients.recipeId, closureIds),
        ),
      )
      .orderBy(recipeIngredients.displaySortOrder),
    db
      .select({
        recipeId: recipePortionOptions.recipeId,
        quantity: recipePortionOptions.quantity,
        unit: recipePortionOptions.unit,
      })
      .from(recipePortionOptions)
      .where(
        and(
          eq(recipePortionOptions.organizationId, organizationId),
          inArray(recipePortionOptions.recipeId, requested),
          eq(recipePortionOptions.isNutritionServing, true),
        ),
      ),
  ]);

  const ingredientIds = [...new Set(lineRows.map((r) => r.ingredientId))];
  const [profiles, equivalencies] = await Promise.all([
    getProfilesForIngredients(db, organizationId, ingredientIds),
    ingredientIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(ingredientUomEquivalencies)
          .where(
            and(
              eq(ingredientUomEquivalencies.organizationId, organizationId),
              inArray(ingredientUomEquivalencies.ingredientId, ingredientIds),
            ),
          ),
  ]);

  const baseAnchors = new Map<string, UomAnchors>();
  for (const row of equivalencies) baseAnchors.set(row.ingredientId, anchorsOf(row));

  const recipeById = new Map<string, Recipe>(recipeRows.map((r) => [r.id, r]));
  const servingByRecipe = new Map<string, { quantity: number; unit: string }>();
  for (const o of servingOptions) {
    servingByRecipe.set(o.recipeId, { quantity: Number(o.quantity), unit: o.unit });
  }

  // ── 3. build per-recipe nutrition line inputs ───────────────────────────────
  const linesByRecipe = new Map<string, { input: NutritionLine; view: NutritionLineView }[]>();
  for (const r of lineRows) {
    const quantity = Number(r.quantity);
    let grams: number | null;
    if (r.dimension === 'weight') {
      grams = Number.isFinite(quantity) && quantity > 0 ? quantity : null;
    } else {
      // Prep anchors REPLACE the base equivalency when the prep has any (§7.2).
      const prep =
        r.prepId !== null
          ? anchorsOf({
              weightGrams: r.prepWeightGrams,
              volumeMl: r.prepVolumeMl,
              eachCount: r.prepEachCount,
            })
          : null;
      const prepHasAny =
        prep !== null &&
        (prep.weightGrams != null || prep.volumeMl != null || prep.eachCount != null);
      const anchors = prepHasAny ? prep : (baseAnchors.get(r.ingredientId) ?? null);
      const converted = convertQuantity(
        quantity,
        CANONICAL_UNIT[r.dimension] === 'count' ? 'count' : 'ml',
        'weight',
        anchors,
      );
      grams = converted.ok && converted.canonical > 0 ? converted.canonical : null;
    }

    const profile = profiles.get(r.ingredientId) ?? null;
    const profileValues: Record<NutrientKey, number | null> | null = profile
      ? {
                caloriesKcal: profile.caloriesKcal,
                totalFatG: profile.totalFatG,
                saturatedFatG: profile.saturatedFatG,
                transFatG: profile.transFatG,
                cholesterolMg: profile.cholesterolMg,
                sodiumMg: profile.sodiumMg,
                totalCarbohydrateG: profile.totalCarbohydrateG,
                dietaryFiberG: profile.dietaryFiberG,
                totalSugarsG: profile.totalSugarsG,
                addedSugarsG: profile.addedSugarsG,
                proteinG: profile.proteinG,
                vitaminDMcg: profile.vitaminDMcg,
                calciumMg: profile.calciumMg,
                ironMg: profile.ironMg,
                potassiumMg: profile.potassiumMg,
          caffeineMg: profile.caffeineMg,
        }
      : null;
    const entry = {
      input: {
        ingredientId: r.ingredientId,
        ingredientName: r.ingredientName,
        edibleWeightGrams: grams,
        profile:
          profile && profileValues
            ? { basisGrams: profile.basisGrams, values: profileValues }
            : null,
      } satisfies NutritionLine,
      view: {
        ingredientId: r.ingredientId,
        ingredientName: r.ingredientName,
        edibleWeightGrams: grams,
        profile:
          profile && profileValues
            ? {
                source: profile.source,
                sourceDescription: profile.sourceDescription,
                brandOwner: profile.brandOwner,
                fdcId: profile.fdcId,
                refreshedAt: profile.refreshedAt,
                values: profileValues,
              }
            : null,
      } satisfies NutritionLineView,
    };
    const list = linesByRecipe.get(r.recipeId);
    if (list) list.push(entry);
    else linesByRecipe.set(r.recipeId, [entry]);
  }

  const edgesByParent = new Map<string, ComponentEdge[]>();
  for (const edge of edges) {
    const existing = edgesByParent.get(edge.recipeId);
    if (existing) existing.push(edge);
    else edgesByParent.set(edge.recipeId, [edge]);
  }

  // ── 4. memoized bottom-up BATCH rollup (children use servingFraction 1) ─────
  const memo = new Map<string, RecipeNutritionResult>();

  const resolveBatch = (
    recipeId: string,
    depth: number,
    visited: Set<string>,
  ): RecipeNutritionResult => {
    const cached = memo.get(recipeId);
    if (cached) return cached;

    const lineEntries = linesByRecipe.get(recipeId) ?? [];
    const components: NutritionComponent[] = [];
    for (const edge of edgesByParent.get(recipeId) ?? []) {
      // Cycle/depth guards mirror the cost tree: contaminate, never loop.
      const looped = depth >= MAX_COMPONENT_DEPTH || visited.has(edge.componentRecipeId);
      const nextVisited = new Set(visited);
      nextVisited.add(edge.componentRecipeId);
      const childRecipe = recipeById.get(edge.componentRecipeId);
      const child: RecipeNutritionResult =
        looped || !childRecipe || childRecipe.deletedAt !== null
          ? {
              status: 'incomplete',
              totals: recipeNutrition({ lines: [], servingFraction: 1 }).totals,
              perServing: null,
              issues: [],
            }
          : resolveBatch(edge.componentRecipeId, depth + 1, nextVisited);
      components.push({
        recipeId: edge.componentRecipeId,
        recipeName: childRecipe?.name ?? 'Unknown recipe',
        yieldWeightGrams: childRecipe?.yieldWeightGrams ?? null,
        usedWeightGrams: edge.quantityGrams,
        child,
      });
    }

    const res = recipeNutrition({
      lines: lineEntries.map((e) => e.input),
      components,
      servingFraction: 1,
    });
    memo.set(recipeId, res);
    return res;
  };

  // ── 5. requested recipes: apply the real nutrition serving ──────────────────
  for (const id of requested) {
    const recipe = recipeById.get(id);
    // Prime the memo (children resolved along the way).
    resolveBatch(id, 0, new Set([id]));

    const serving =
      servingByRecipe.get(id) ??
      (recipe?.nutritionServingQuantity != null && recipe.nutritionServingUnit
        ? {
            quantity: recipe.nutritionServingQuantity,
            unit: recipe.nutritionServingUnit,
          }
        : null);
    const fraction = recipe
      ? nutritionServingFraction({
          quantity: serving?.quantity ?? null,
          unit: serving?.unit ?? null,
          yieldQuantity: recipe.yieldQuantity,
          yieldUnit: recipe.yieldUnit,
          yieldPortions: recipe.yieldPortions,
          yieldWeightGrams: recipe.yieldWeightGrams,
        })
      : null;

    const lineEntries = linesByRecipe.get(id) ?? [];
    const components: NutritionComponent[] = [];
    for (const edge of edgesByParent.get(id) ?? []) {
      const childRecipe = recipeById.get(edge.componentRecipeId);
      const child =
        memo.get(edge.componentRecipeId) ??
        ({
          status: 'incomplete',
          totals: recipeNutrition({ lines: [], servingFraction: 1 }).totals,
          perServing: null,
          issues: [],
        } satisfies RecipeNutritionResult);
      components.push({
        recipeId: edge.componentRecipeId,
        recipeName: childRecipe?.name ?? 'Unknown recipe',
        yieldWeightGrams: childRecipe?.yieldWeightGrams ?? null,
        usedWeightGrams: edge.quantityGrams,
        child,
      });
    }

    result.set(id, {
      result: recipeNutrition({
        lines: lineEntries.map((e) => e.input),
        components,
        servingFraction: fraction?.fraction ?? null,
      }),
      lines: lineEntries.map((e) => e.view),
      servingGrams: fraction?.servingGrams ?? null,
    });
  }

  return result;
}
