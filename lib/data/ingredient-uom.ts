import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ingredientPrepActions,
  ingredientUomEquivalencies,
  recipeIngredients,
  type IngredientPrepAction,
  type IngredientUomEquivalency,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { lockActiveIngredient } from '@/lib/data/ingredients';
import { hasUsableAnchorPair, type UomAnchors } from '@/lib/calculations/uom';

/**
 * UoM equivalency + prep action data layer (Recipes 2.0 Fase 4, plan §6.6).
 * Every function is org-scoped (RULE #1) and runs inside the caller's
 * `withOrg` transaction. Operational data — no money anywhere, so both roles
 * may mutate (like allergens/structure).
 *
 * Invariants enforced here, on top of the DB constraints (unique row per
 * ingredient, positive anchors, yield_bps 1..10000):
 * - an equivalency is only stored with ≥ 2 positive anchors (a single anchor
 *   converts nothing);
 * - mutations lock the ACTIVE ingredient row first, serializing with
 *   ingredient delete (same pattern as allergens/pricing);
 * - a prep action referenced by a recipe line cannot be deleted (`in_use`,
 *   mirroring the DB RESTRICT) — the UI detaches first.
 */

export type IngredientUomState = {
  equivalency: IngredientUomEquivalency | null;
  prepActions: IngredientPrepAction[];
};

export async function getIngredientUom(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<IngredientUomState> {
  const [equivalencies, prepActions] = await Promise.all([
    db
      .select()
      .from(ingredientUomEquivalencies)
      .where(
        and(
          eq(ingredientUomEquivalencies.organizationId, organizationId),
          eq(ingredientUomEquivalencies.ingredientId, ingredientId),
        ),
      )
      .limit(1),
    db
      .select()
      .from(ingredientPrepActions)
      .where(
        and(
          eq(ingredientPrepActions.organizationId, organizationId),
          eq(ingredientPrepActions.ingredientId, ingredientId),
        ),
      )
      .orderBy(asc(ingredientPrepActions.sortOrder), asc(ingredientPrepActions.name)),
  ]);
  return { equivalency: equivalencies[0] ?? null, prepActions };
}

/** Batch loader (no N+1): UoM state for many ingredients at once. */
export async function loadIngredientUomByIngredient(
  db: TenantClient,
  organizationId: string,
  ingredientIds: string[],
): Promise<Map<string, IngredientUomState>> {
  const map = new Map<string, IngredientUomState>();
  if (ingredientIds.length === 0) return map;
  const ids = [...new Set(ingredientIds)];

  const [equivalencies, prepActions] = await Promise.all([
    db
      .select()
      .from(ingredientUomEquivalencies)
      .where(
        and(
          eq(ingredientUomEquivalencies.organizationId, organizationId),
          inArray(ingredientUomEquivalencies.ingredientId, ids),
        ),
      ),
    db
      .select()
      .from(ingredientPrepActions)
      .where(
        and(
          eq(ingredientPrepActions.organizationId, organizationId),
          inArray(ingredientPrepActions.ingredientId, ids),
        ),
      )
      .orderBy(asc(ingredientPrepActions.sortOrder), asc(ingredientPrepActions.name)),
  ]);

  const stateFor = (ingredientId: string): IngredientUomState => {
    const existing = map.get(ingredientId);
    if (existing) return existing;
    const created: IngredientUomState = { equivalency: null, prepActions: [] };
    map.set(ingredientId, created);
    return created;
  };
  for (const row of equivalencies) stateFor(row.ingredientId).equivalency = row;
  for (const row of prepActions) stateFor(row.ingredientId).prepActions.push(row);
  return map;
}

export type UpsertEquivalencyResult =
  | { status: 'done'; equivalency: IngredientUomEquivalency }
  | { status: 'not_found' }
  | { status: 'invalid_anchors' };

/**
 * Create or replace THE equivalency of an ingredient (one active row per
 * ingredient — DB unique). Requires ≥ 2 positive anchors.
 */
export async function upsertIngredientEquivalency(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  input: UomAnchors & { source: 'manual' | 'standard' },
  updatedBy: string | null,
): Promise<UpsertEquivalencyResult> {
  if (!hasUsableAnchorPair(input)) return { status: 'invalid_anchors' };
  if (!(await lockActiveIngredient(db, organizationId, ingredientId))) {
    return { status: 'not_found' };
  }

  const values = {
    organizationId,
    ingredientId,
    weightGrams: input.weightGrams,
    volumeMl: input.volumeMl,
    eachCount: input.eachCount,
    source: input.source,
    updatedBy,
  };
  const [row] = await db
    .insert(ingredientUomEquivalencies)
    .values(values)
    .onConflictDoUpdate({
      target: [
        ingredientUomEquivalencies.organizationId,
        ingredientUomEquivalencies.ingredientId,
      ],
      set: {
        weightGrams: values.weightGrams,
        volumeMl: values.volumeMl,
        eachCount: values.eachCount,
        source: values.source,
        updatedBy,
        updatedAt: new Date(),
      },
    })
    .returning();
  return { status: 'done', equivalency: row! };
}

/** Removes the ingredient's equivalency. Existing lines keep their canonical quantity. */
export async function deleteIngredientEquivalency(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<'done' | 'not_found'> {
  const deleted = await db
    .delete(ingredientUomEquivalencies)
    .where(
      and(
        eq(ingredientUomEquivalencies.organizationId, organizationId),
        eq(ingredientUomEquivalencies.ingredientId, ingredientId),
      ),
    )
    .returning({ id: ingredientUomEquivalencies.id });
  return deleted.length > 0 ? 'done' : 'not_found';
}

export type SavePrepActionInput = UomAnchors & {
  name: string;
  yieldBps: number;
  sortOrder?: number;
};

export type SavePrepActionResult =
  | { status: 'done'; prepAction: IngredientPrepAction }
  | { status: 'not_found' }
  | { status: 'duplicate_name' };

const DUPLICATE_NAME_CONSTRAINT = 'ingredient_prep_actions_org_ingredient_name_key';

function isDuplicateName(error: unknown): boolean {
  // pg/PGlite raise a structured error carrying the violated constraint;
  // drizzle sometimes wraps it in `cause`. Check both, plus the message.
  const candidates: unknown[] = [error, (error as { cause?: unknown })?.cause];
  return candidates.some((e) => {
    if (e == null || typeof e !== 'object') return false;
    const { constraint, message } = e as { constraint?: string; message?: string };
    return (
      constraint === DUPLICATE_NAME_CONSTRAINT ||
      (typeof message === 'string' && message.includes(DUPLICATE_NAME_CONSTRAINT))
    );
  });
}

export async function createPrepAction(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  input: SavePrepActionInput,
): Promise<SavePrepActionResult> {
  if (!(await lockActiveIngredient(db, organizationId, ingredientId))) {
    return { status: 'not_found' };
  }
  try {
    const [row] = await db
      .insert(ingredientPrepActions)
      .values({
        organizationId,
        ingredientId,
        name: input.name,
        yieldBps: input.yieldBps,
        weightGrams: input.weightGrams,
        volumeMl: input.volumeMl,
        eachCount: input.eachCount,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    return { status: 'done', prepAction: row! };
  } catch (error) {
    if (isDuplicateName(error)) return { status: 'duplicate_name' };
    throw error;
  }
}

export async function updatePrepAction(
  db: TenantClient,
  organizationId: string,
  prepActionId: string,
  input: SavePrepActionInput,
): Promise<SavePrepActionResult> {
  try {
    const [row] = await db
      .update(ingredientPrepActions)
      .set({
        name: input.name,
        yieldBps: input.yieldBps,
        weightGrams: input.weightGrams,
        volumeMl: input.volumeMl,
        eachCount: input.eachCount,
        sortOrder: input.sortOrder ?? 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ingredientPrepActions.organizationId, organizationId),
          eq(ingredientPrepActions.id, prepActionId),
        ),
      )
      .returning();
    if (!row) return { status: 'not_found' };
    return { status: 'done', prepAction: row };
  } catch (error) {
    if (isDuplicateName(error)) return { status: 'duplicate_name' };
    throw error;
  }
}

/**
 * Deletes a prep action unless a recipe line references it (`in_use`, checked
 * app-side for a typed error; the DB RESTRICT FK is the backstop).
 */
export async function deletePrepAction(
  db: TenantClient,
  organizationId: string,
  prepActionId: string,
): Promise<'done' | 'not_found' | 'in_use'> {
  const referencing = await db
    .select({ id: recipeIngredients.id })
    .from(recipeIngredients)
    .where(
      and(
        eq(recipeIngredients.organizationId, organizationId),
        eq(recipeIngredients.prepActionId, prepActionId),
      ),
    )
    .limit(1);
  if (referencing.length > 0) return 'in_use';

  const deleted = await db
    .delete(ingredientPrepActions)
    .where(
      and(
        eq(ingredientPrepActions.organizationId, organizationId),
        eq(ingredientPrepActions.id, prepActionId),
      ),
    )
    .returning({ id: ingredientPrepActions.id });
  return deleted.length > 0 ? 'done' : 'not_found';
}
