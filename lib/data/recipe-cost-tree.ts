import { and, eq, inArray } from 'drizzle-orm';
import {
  ingredientPrepActions,
  ingredients,
  recipeComponents,
  recipeIngredients,
  recipes,
} from '@/lib/db/schema';
import type { Recipe } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import {
  componentRawCostCents,
  recipeCost,
  type RecipeCost,
  type RecipeCostLine,
} from '@/lib/calculations/recipeCost';
import { MAX_COMPONENT_DEPTH } from '@/lib/calculations/production';

/**
 * THE shared recipe-cost resolver (sub-recipes plan §Cost Cascade). Every live
 * cost consumer resolves through here so sub-recipe component costs cascade
 * identically everywhere — no consumer grows its own recursion or N+1 loader.
 *
 * Complete-or-null (the house `componentCost` pattern): a trashed/missing
 * recipe, a component with a missing/invalid yield weight, a cycle, or a chain
 * beyond MAX_COMPONENT_DEPTH makes that recipe's resolution INCOMPLETE
 * (`cost: null`) — never a silent zero. Component-free recipes produce results
 * identical to calling `recipeCost()` directly (regression-tested).
 *
 * Batching: one iterative closure walk over `recipe_components` (bounded by
 * MAX_COMPONENT_DEPTH — strictly fewer queries than recipes touched), then one
 * query each for recipe rows, ingredient lines (+ prices, join NOT
 * deleted_at-filtered, mirroring today's cost loaders), and component lines.
 */

export type RecipeCostResolution =
  | {
      complete: true;
      cost: RecipeCost;
      /** Rounded DISPLAY cost per component line id (totals never re-add these). */
      componentLineCostsCents: Map<string, number>;
      /**
       * UNROUNDED per-line component material costs — feed to `recipeCost()`
       * as `componentMaterialCostsCents` when a consumer re-derives the cost
       * itself (e.g. dashboard margin metrics).
       */
      componentMaterialCostsCents: number[];
    }
  | {
      complete: false;
      cost: null;
      componentLineCostsCents: null;
      reason: 'recipe_unavailable' | 'component_invalid';
    };

type ComponentEdge = {
  id: string;
  recipeId: string;
  componentRecipeId: string;
  quantityGrams: number;
};

const INCOMPLETE = (
  reason: 'recipe_unavailable' | 'component_invalid',
): RecipeCostResolution => ({
  complete: false,
  cost: null,
  componentLineCostsCents: null,
  reason,
});

export async function resolveRecipeCostTree(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<Map<string, RecipeCostResolution>> {
  const result = new Map<string, RecipeCostResolution>();
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

  // ── 2. batch-load recipes + direct lines for the whole closure ──────────────
  const closureIds = [...closure];
  const [recipeRows, lineRows] = await Promise.all([
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
        quantity: recipeIngredients.quantity,
        dimension: ingredients.dimension,
        priceCents: ingredients.priceCents,
        // Prep-action usable yield inflates required-purchase cost (§6.6/§7.3).
        // LEFT JOIN: a line with no prep action keeps yield NULL → no loss.
        prepYieldBps: ingredientPrepActions.yieldBps,
      })
      .from(recipeIngredients)
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
      ),
  ]);

  const recipeById = new Map<string, Recipe>(recipeRows.map((r) => [r.id, r]));
  const linesByRecipe = new Map<string, RecipeCostLine[]>();
  for (const r of lineRows) {
    const line: RecipeCostLine = {
      dimension: r.dimension,
      priceCents: r.priceCents,
      quantity: Number(r.quantity),
      ...(r.prepYieldBps != null ? { prepYieldBps: r.prepYieldBps } : {}),
    };
    const existing = linesByRecipe.get(r.recipeId);
    if (existing) existing.push(line);
    else linesByRecipe.set(r.recipeId, [line]);
  }
  const edgesByParent = new Map<string, ComponentEdge[]>();
  for (const edge of edges) {
    const existing = edgesByParent.get(edge.recipeId);
    if (existing) existing.push(edge);
    else edgesByParent.set(edge.recipeId, [edge]);
  }

  // ── 3. memoized bottom-up resolution with visited/depth guards ──────────────
  const memo = new Map<string, RecipeCostResolution>();

  const resolve = (
    recipeId: string,
    depth: number,
    visited: Set<string>,
  ): RecipeCostResolution => {
    const cached = memo.get(recipeId);
    if (cached) return cached;

    const recipe = recipeById.get(recipeId);
    if (!recipe || recipe.deletedAt !== null) {
      const res = INCOMPLETE('recipe_unavailable');
      memo.set(recipeId, res);
      return res;
    }

    const componentMaterialCostsCents: number[] = [];
    const componentLineCostsCents = new Map<string, number>();
    for (const edge of edgesByParent.get(recipeId) ?? []) {
      // Corrupted-data guards: incomplete, never throw or loop.
      if (depth >= MAX_COMPONENT_DEPTH || visited.has(edge.componentRecipeId)) {
        const res = INCOMPLETE('component_invalid');
        memo.set(recipeId, res);
        return res;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(edge.componentRecipeId);
      const child = resolve(edge.componentRecipeId, depth + 1, nextVisited);
      if (!child.complete) {
        const res = INCOMPLETE(child.reason);
        memo.set(recipeId, res);
        return res;
      }
      const childRecipe = recipeById.get(edge.componentRecipeId);
      const raw = componentRawCostCents(
        child.cost.totalCostCents,
        edge.quantityGrams,
        childRecipe?.yieldWeightGrams,
      );
      if (raw === null) {
        const res = INCOMPLETE('component_invalid');
        memo.set(recipeId, res);
        return res;
      }
      componentMaterialCostsCents.push(raw);
      componentLineCostsCents.set(edge.id, Math.round(raw));
    }

    const cost = recipeCost({
      yieldPortions: recipe.yieldPortions,
      yieldPercentage: recipe.yieldPercentage,
      laborCostCents: recipe.laborCostCents,
      energyCostCents: recipe.energyCostCents,
      packagingCostCents: recipe.packagingCostCents,
      lines: linesByRecipe.get(recipeId) ?? [],
      componentMaterialCostsCents,
    });
    const res: RecipeCostResolution = {
      complete: true,
      cost,
      componentLineCostsCents,
      componentMaterialCostsCents,
    };
    memo.set(recipeId, res);
    return res;
  };

  for (const id of requested) {
    result.set(id, resolve(id, 0, new Set([id])));
  }
  return result;
}
