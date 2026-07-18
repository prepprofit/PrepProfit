'use server';

import { revalidatePath } from 'next/cache';

import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { enforceRateLimit } from '@/lib/rate-limit';
import { auditActor } from '@/lib/data/audit';
import {
  getUsdaProfileIdentity,
  upsertNutritionProfile,
  type UpsertNutritionProfileInput,
} from '@/lib/data/ingredient-nutrition';
import {
  refreshIngredientNutritionSchema,
  saveIngredientNutritionSchema,
  searchUsdaSchema,
} from '@/lib/validation/ingredient-nutrition';
import { getUsdaFood, searchUsdaFoods, type UsdaFood } from '@/lib/usda/client';
import type { IngredientNutritionProfile } from '@/lib/db/schema';
import type { ActionResult, ActionErrorCode } from '@/lib/action-result';

/**
 * Server Actions for ingredient nutrition (Recipes 2.0 Fase 6, §6.7/§9.6).
 * MANAGER-ONLY (owner decision D5: kitchen views nutrition, only managers edit
 * profiles), `FORBIDDEN` before any data access. Search hits the external USDA
 * API → rate-limited per org+user (`usdaSearch` bucket) BEFORE any org work.
 * A USDA save RE-FETCHES the food server-side by fdcId — nutrient values from
 * the client are only ever accepted on the `custom` path, where Zod bounds
 * them. All mutations are audited inside `withOrg`. RULE #1 throughout.
 */

function usdaErrorCode(
  reason: 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'NOT_FOUND',
): ActionErrorCode {
  if (reason === 'NOT_CONFIGURED') return 'USDA_NOT_CONFIGURED';
  if (reason === 'NOT_FOUND') return 'NOT_FOUND';
  return 'USDA_UNAVAILABLE';
}

export async function searchUsdaFoodsAction(
  input: unknown,
): Promise<ActionResult<{ foods: UsdaFood[] }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = searchUsdaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const userId = await getUserId();
    const limit = await enforceRateLimit(
      getDb(),
      'usdaSearch',
      `${organizationId}:${userId}`,
    );
    if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

    const result = await searchUsdaFoods(parsed.data.query, parsed.data.scope);
    if (!result.ok) return { ok: false, code: usdaErrorCode(result.reason) };
    return { ok: true, data: { foods: result.value } };
  } catch (error) {
    return unexpected('searchUsdaFoodsAction', error);
  }
}

/** Map a fetched USDA food onto the profile upsert contract. */
function usdaFoodToProfileInput(food: UsdaFood): UpsertNutritionProfileInput {
  const published = food.publishedDate ? new Date(food.publishedDate) : null;
  return {
    source: 'usda',
    fdcId: food.fdcId,
    fdcDataType: food.dataType,
    sourceDescription: food.description,
    brandOwner: food.brandOwner,
    sourceUpdatedAt:
      published && !Number.isNaN(published.getTime()) ? published : null,
    values: food.nutrientsPer100g,
  };
}

function revalidateNutritionSurfaces(): void {
  // Profiles feed every recipe's Nutrition tab (derive-on-read).
  revalidatePath('/recipes');
  revalidatePath('/ingredients');
}

export async function saveIngredientNutritionAction(
  input: unknown,
): Promise<ActionResult<{ profile: IngredientNutritionProfile }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = saveIngredientNutritionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();

    let profileInput: UpsertNutritionProfileInput;
    if (parsed.data.source === 'usda') {
      // Server-side re-fetch: the snapshot NEVER trusts client nutrient values.
      const userId = await getUserId();
      const limit = await enforceRateLimit(
        getDb(),
        'usdaSearch',
        `${organizationId}:${userId}`,
      );
      if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };
      const food = await getUsdaFood(parsed.data.fdcId);
      if (!food.ok) return { ok: false, code: usdaErrorCode(food.reason) };
      profileInput = usdaFoodToProfileInput(food.value);
    } else {
      profileInput = {
        source: 'custom',
        fdcId: null,
        fdcDataType: null,
        sourceDescription: null,
        brandOwner: null,
        sourceUpdatedAt: null,
        values: parsed.data.values,
      };
    }

    const ingredientId = parsed.data.ingredientId;
    const result = await withOrg(organizationId, (tx) =>
      upsertNutritionProfile(tx, organizationId, ingredientId, profileInput, actor),
    );
    if (result.status !== 'done') return { ok: false, code: 'NOT_FOUND' };
    revalidateNutritionSurfaces();
    return { ok: true, data: { profile: result.profile } };
  } catch (error) {
    return unexpected('saveIngredientNutritionAction', error);
  }
}

export async function refreshIngredientNutritionAction(
  input: unknown,
): Promise<ActionResult<{ profile: IngredientNutritionProfile }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = refreshIngredientNutritionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const actor = await auditActor();
    const ingredientId = parsed.data.ingredientId;

    const identity = await withOrg(organizationId, (tx) =>
      getUsdaProfileIdentity(tx, organizationId, ingredientId),
    );
    if (!identity) return { ok: false, code: 'NOT_FOUND' };

    const userId = await getUserId();
    const limit = await enforceRateLimit(
      getDb(),
      'usdaSearch',
      `${organizationId}:${userId}`,
    );
    if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

    const food = await getUsdaFood(identity.fdcId);
    if (!food.ok) return { ok: false, code: usdaErrorCode(food.reason) };

    const result = await withOrg(organizationId, (tx) =>
      upsertNutritionProfile(
        tx,
        organizationId,
        ingredientId,
        usdaFoodToProfileInput(food.value),
        actor,
        { refreshed: true },
      ),
    );
    if (result.status !== 'done') return { ok: false, code: 'NOT_FOUND' };
    revalidateNutritionSurfaces();
    return { ok: true, data: { profile: result.profile } };
  } catch (error) {
    return unexpected('refreshIngredientNutritionAction', error);
  }
}
