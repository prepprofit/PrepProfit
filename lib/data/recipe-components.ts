import { and, asc, eq, exists, inArray, isNull, sql } from 'drizzle-orm';
import { recipeComponents, recipes } from '@/lib/db/schema';
import type { RecipeComponent } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { MAX_COMPONENT_DEPTH } from '@/lib/calculations/production';

/**
 * Sub-recipe component lines, ALWAYS scoped by `organizationId`. Mirrors
 * lib/data/recipe-ingredients.ts (same guards, same reorder contract) plus the
 * graph invariants the DB cannot express alone:
 *
 *  - no cycles: adding parent → component must not make parent reachable from
 *    component (recursive CTE, checked under FOR UPDATE locks on both recipe
 *    rows in deterministic id order — concurrent A→B and B→A serialize on the
 *    same two locks, so the second insert sees the first edge and is rejected);
 *  - max chain depth: the longest resulting chain (edges above the parent +
 *    the new edge + edges below the component) must not exceed
 *    MAX_COMPONENT_DEPTH;
 *  - an active parent only references ACTIVE components with a POSITIVE
 *    finished yield weight (trash/restore/purge/yield-clear guards call the
 *    count/lock helpers here).
 */

export type RecipeComponentLine = RecipeComponent & {
  componentName: string;
  componentYieldWeightGrams: number | null;
  componentDeletedAt: Date | null;
};

/** Component lines of the given recipes, with component-recipe metadata. */
export async function listRecipeComponents(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<RecipeComponentLine[]> {
  if (recipeIds.length === 0) return [];
  const rows = await db
    .select({
      line: recipeComponents,
      componentName: recipes.name,
      componentYieldWeightGrams: recipes.yieldWeightGrams,
      componentDeletedAt: recipes.deletedAt,
    })
    .from(recipeComponents)
    .innerJoin(
      recipes,
      and(
        eq(recipes.organizationId, recipeComponents.organizationId),
        eq(recipes.id, recipeComponents.componentRecipeId),
      ),
    )
    .where(
      and(
        eq(recipeComponents.organizationId, organizationId),
        inArray(recipeComponents.recipeId, recipeIds),
      ),
    )
    .orderBy(asc(recipeComponents.sortOrder), asc(recipeComponents.id));
  return rows.map((r) => ({
    ...r.line,
    componentName: r.componentName,
    componentYieldWeightGrams: r.componentYieldWeightGrams,
    componentDeletedAt: r.componentDeletedAt,
  }));
}

export type ComponentPickerRecipe = {
  id: string;
  name: string;
  yieldWeightGrams: number | null;
  /** True when the recipe can be picked (active, positive yield, not a cycle). */
  selectable: boolean;
  /** Why it is disabled, for the picker's explain-disabled states. */
  disabledReason: 'no_yield' | 'cycle' | null;
};

/**
 * Active same-org recipes for the component picker, excluding the parent
 * itself. Recipes without a positive yield weight and recipes that would form
 * a cycle (ancestors of the parent) are listed but flagged NOT selectable so
 * the UI can explain the disabled state. The server-side add remains
 * authoritative regardless.
 */
export async function listComponentPickerRecipes(
  db: TenantClient,
  organizationId: string,
  parentRecipeId: string,
): Promise<ComponentPickerRecipe[]> {
  const [candidates, ancestors] = await Promise.all([
    db
      .select({
        id: recipes.id,
        name: recipes.name,
        yieldWeightGrams: recipes.yieldWeightGrams,
      })
      .from(recipes)
      .where(
        and(
          eq(recipes.organizationId, organizationId),
          isNull(recipes.deletedAt),
          sql`${recipes.id} <> ${parentRecipeId}`,
        ),
      )
      .orderBy(asc(recipes.name), asc(recipes.id)),
    collectAncestorIds(db, organizationId, parentRecipeId),
  ]);
  return candidates.map((r) => {
    const hasYield = r.yieldWeightGrams != null && r.yieldWeightGrams > 0;
    const isCycle = ancestors.has(r.id);
    return {
      ...r,
      selectable: hasYield && !isCycle,
      disabledReason: isCycle ? 'cycle' : hasYield ? null : 'no_yield',
    };
  });
}

/**
 * Lock the given recipe rows FOR UPDATE in deterministic id order (dedup +
 * sort), so every writer that touches the component graph serializes on the
 * same locks in the same order (no deadlocks, no check-then-write races).
 * Returns the locked rows' soft-delete state and yield weight for the caller's
 * guard. Missing ids are simply absent from the result.
 */
export async function lockRecipeComponentEndpoints(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<
  Map<string, { deletedAt: Date | null; yieldWeightGrams: number | null }>
> {
  const ids = [...new Set(recipeIds)].sort();
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: recipes.id,
      deletedAt: recipes.deletedAt,
      yieldWeightGrams: recipes.yieldWeightGrams,
    })
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), inArray(recipes.id, ids)))
    .orderBy(asc(recipes.id))
    .for('update');
  return new Map(
    rows.map((r) => [
      r.id,
      { deletedAt: r.deletedAt, yieldWeightGrams: r.yieldWeightGrams },
    ]),
  );
}

type DepthRow = { id: string; depth: number };

// Drizzle's execute() result shape differs per driver (neon-serverless vs
// PGlite); both expose `.rows`, some return the array directly.
function resultRows(res: unknown): DepthRow[] {
  if (Array.isArray(res)) return res as DepthRow[];
  const rows = (res as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as DepthRow[]) : [];
}

// Hard recursion cap for the CTEs: strictly above any legal chain so a legal
// write is never cut short, but bounded so corrupted data can't loop.
const CTE_DEPTH_CAP = MAX_COMPONENT_DEPTH + 3;

/** All recipes reachable DOWNWARD from `recipeId`, with their edge depth. */
async function collectDescendants(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<DepthRow[]> {
  const res = await db.execute(sql`
    WITH RECURSIVE down AS (
      SELECT rc.component_recipe_id AS id, 1 AS depth
        FROM recipe_components rc
       WHERE rc.organization_id = ${organizationId} AND rc.recipe_id = ${recipeId}
      UNION ALL
      SELECT rc.component_recipe_id, d.depth + 1
        FROM recipe_components rc
        JOIN down d ON rc.recipe_id = d.id
       WHERE rc.organization_id = ${organizationId} AND d.depth < ${CTE_DEPTH_CAP}
    )
    SELECT id, max(depth)::int AS depth FROM down GROUP BY id
  `);
  return resultRows(res);
}

/** All recipes reachable UPWARD from `recipeId` (its ancestors as a set). */
async function collectAncestorIds(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<Set<string>> {
  const res = await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT rc.recipe_id AS id, 1 AS depth
        FROM recipe_components rc
       WHERE rc.organization_id = ${organizationId}
         AND rc.component_recipe_id = ${recipeId}
      UNION ALL
      SELECT rc.recipe_id, u.depth + 1
        FROM recipe_components rc
        JOIN up u ON rc.component_recipe_id = u.id
       WHERE rc.organization_id = ${organizationId} AND u.depth < ${CTE_DEPTH_CAP}
    )
    SELECT id, max(depth)::int AS depth FROM up GROUP BY id
  `);
  return new Set(resultRows(res).map((r) => r.id));
}

export type ComponentGraphCheck =
  | { ok: true }
  | { ok: false; reason: 'cycle' | 'depth_exceeded' };

/**
 * Would adding the edge parent → component make the graph cyclic or push the
 * longest chain beyond MAX_COMPONENT_DEPTH edges? Callers MUST hold the
 * endpoint locks (lockRecipeComponentEndpoints) before calling, or the answer
 * can be stale by commit time.
 */
export async function assertNoRecipeComponentCycle(
  db: TenantClient,
  organizationId: string,
  parentRecipeId: string,
  componentRecipeId: string,
): Promise<ComponentGraphCheck> {
  const [descendants, ancestors] = await Promise.all([
    collectDescendants(db, organizationId, componentRecipeId),
    // Depth of the chain ABOVE the parent: longest path ending at parent.
    collectAncestorsWithDepth(db, organizationId, parentRecipeId),
  ]);
  if (
    parentRecipeId === componentRecipeId ||
    descendants.some((d) => d.id === parentRecipeId)
  ) {
    return { ok: false, reason: 'cycle' };
  }
  const downDepth = descendants.reduce((m, d) => Math.max(m, d.depth), 0);
  const upDepth = ancestors.reduce((m, d) => Math.max(m, d.depth), 0);
  if (upDepth + 1 + downDepth > MAX_COMPONENT_DEPTH) {
    return { ok: false, reason: 'depth_exceeded' };
  }
  return { ok: true };
}

async function collectAncestorsWithDepth(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<DepthRow[]> {
  const res = await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT rc.recipe_id AS id, 1 AS depth
        FROM recipe_components rc
       WHERE rc.organization_id = ${organizationId}
         AND rc.component_recipe_id = ${recipeId}
      UNION ALL
      SELECT rc.recipe_id, u.depth + 1
        FROM recipe_components rc
        JOIN up u ON rc.component_recipe_id = u.id
       WHERE rc.organization_id = ${organizationId} AND u.depth < ${CTE_DEPTH_CAP}
    )
    SELECT id, max(depth)::int AS depth FROM up GROUP BY id
  `);
  return resultRows(res);
}

export type AddRecipeComponentInput = {
  componentRecipeId: string;
  quantityGrams: number;
  sortOrder?: number;
};

export type AddRecipeComponentResult =
  | { ok: true; row: RecipeComponent }
  | {
      ok: false;
      reason:
        | 'recipe_not_active'
        | 'component_invalid' // missing/trashed/self/no positive yield
        | 'duplicate'
        | 'cycle'
        | 'depth_exceeded';
    };

export async function addRecipeComponent(
  db: TenantClient,
  organizationId: string,
  parentRecipeId: string,
  input: AddRecipeComponentInput,
): Promise<AddRecipeComponentResult> {
  if (input.componentRecipeId === parentRecipeId) {
    return { ok: false, reason: 'component_invalid' };
  }
  // Lock BOTH endpoints FOR UPDATE (deterministic order) before any check.
  const locked = await lockRecipeComponentEndpoints(db, organizationId, [
    parentRecipeId,
    input.componentRecipeId,
  ]);
  const parent = locked.get(parentRecipeId);
  if (!parent || parent.deletedAt !== null) {
    return { ok: false, reason: 'recipe_not_active' };
  }
  const component = locked.get(input.componentRecipeId);
  if (
    !component ||
    component.deletedAt !== null ||
    component.yieldWeightGrams == null ||
    component.yieldWeightGrams <= 0
  ) {
    return { ok: false, reason: 'component_invalid' };
  }

  const graph = await assertNoRecipeComponentCycle(
    db,
    organizationId,
    parentRecipeId,
    input.componentRecipeId,
  );
  if (!graph.ok) return { ok: false, reason: graph.reason };

  // Pre-check the duplicate (the UNIQUE constraint stays the real guard, but a
  // constraint error would abort the caller's withOrg transaction).
  const [existing] = await db
    .select({ id: recipeComponents.id })
    .from(recipeComponents)
    .where(
      and(
        eq(recipeComponents.organizationId, organizationId),
        eq(recipeComponents.recipeId, parentRecipeId),
        eq(recipeComponents.componentRecipeId, input.componentRecipeId),
      ),
    )
    .limit(1);
  if (existing) return { ok: false, reason: 'duplicate' };

  const [row] = await db
    .insert(recipeComponents)
    .values({
      organizationId,
      recipeId: parentRecipeId,
      componentRecipeId: input.componentRecipeId,
      quantityGrams: input.quantityGrams,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  if (!row) throw new Error('Failed to add component to recipe.');
  return { ok: true, row };
}

/** EXISTS guard: the parent recipe is ACTIVE and in this org (see recipe-ingredients). */
function parentRecipeIsActive(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(recipes)
      .where(
        and(
          eq(recipes.organizationId, organizationId),
          eq(recipes.id, recipeId),
          isNull(recipes.deletedAt),
        ),
      ),
  );
}

export async function updateRecipeComponent(
  db: TenantClient,
  organizationId: string,
  parentRecipeId: string,
  id: string,
  input: { quantityGrams: number; sortOrder?: number },
): Promise<RecipeComponent | null> {
  const set: { quantityGrams: number; sortOrder?: number } = {
    quantityGrams: input.quantityGrams,
  };
  if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
  const [row] = await db
    .update(recipeComponents)
    .set(set)
    .where(
      and(
        eq(recipeComponents.organizationId, organizationId),
        eq(recipeComponents.id, id),
        eq(recipeComponents.recipeId, parentRecipeId),
        parentRecipeIsActive(db, organizationId, parentRecipeId),
      ),
    )
    .returning();
  return row ?? null;
}

/** Returns true iff a line was actually removed (active same-org parent, matching id). */
export async function removeRecipeComponent(
  db: TenantClient,
  organizationId: string,
  parentRecipeId: string,
  id: string,
): Promise<boolean> {
  const removed = await db
    .delete(recipeComponents)
    .where(
      and(
        eq(recipeComponents.organizationId, organizationId),
        eq(recipeComponents.id, id),
        eq(recipeComponents.recipeId, parentRecipeId),
        parentRecipeIsActive(db, organizationId, parentRecipeId),
      ),
    )
    .returning({ id: recipeComponents.id });
  return removed.length > 0;
}

export type ReorderRecipeComponentsOutcome =
  | { status: 'ok'; count: number }
  | { status: 'not_found' }
  | { status: 'stale' };

/**
 * Atomically renumber a recipe's component lines to `orderedLineIds` — the
 * exact contract of `reorderRecipeIngredients` (lock current lines FOR UPDATE
 * in deterministic id order, require an exact id-set match, renumber, else
 * `stale` and write nothing).
 */
export async function reorderRecipeComponents(
  db: TenantClient,
  organizationId: string,
  parentRecipeId: string,
  orderedLineIds: string[],
): Promise<ReorderRecipeComponentsOutcome> {
  const [recipe] = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, parentRecipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .limit(1);
  if (!recipe) return { status: 'not_found' };

  const current = await db
    .select({ id: recipeComponents.id })
    .from(recipeComponents)
    .where(
      and(
        eq(recipeComponents.organizationId, organizationId),
        eq(recipeComponents.recipeId, parentRecipeId),
      ),
    )
    .orderBy(recipeComponents.id)
    .for('update');

  const requested = new Set(orderedLineIds);
  if (requested.size !== orderedLineIds.length) return { status: 'stale' };
  const currentIds = new Set(current.map((r) => r.id));
  if (requested.size !== currentIds.size) return { status: 'stale' };
  for (const lineId of requested) {
    if (!currentIds.has(lineId)) return { status: 'stale' };
  }

  for (let i = 0; i < orderedLineIds.length; i += 1) {
    await db
      .update(recipeComponents)
      .set({ sortOrder: i })
      .where(
        and(
          eq(recipeComponents.organizationId, organizationId),
          eq(recipeComponents.recipeId, parentRecipeId),
          eq(recipeComponents.id, orderedLineIds[i]!),
        ),
      );
  }
  return { status: 'ok', count: orderedLineIds.length };
}

/** Parents with an ACTIVE recipe row referencing `componentRecipeId`. */
export async function countActiveParentsUsingComponent(
  db: TenantClient,
  organizationId: string,
  componentRecipeId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recipeComponents)
    .innerJoin(
      recipes,
      and(
        eq(recipes.organizationId, recipeComponents.organizationId),
        eq(recipes.id, recipeComponents.recipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .where(
      and(
        eq(recipeComponents.organizationId, organizationId),
        eq(recipeComponents.componentRecipeId, componentRecipeId),
      ),
    );
  return row?.count ?? 0;
}

/** ANY surviving component row referencing `componentRecipeId` (incl. trashed parents). */
export async function countAnyParentsUsingComponent(
  db: TenantClient,
  organizationId: string,
  componentRecipeId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recipeComponents)
    .where(
      and(
        eq(recipeComponents.organizationId, organizationId),
        eq(recipeComponents.componentRecipeId, componentRecipeId),
      ),
    );
  return row?.count ?? 0;
}
