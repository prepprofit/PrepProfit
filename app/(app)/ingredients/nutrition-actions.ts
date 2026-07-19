'use server';

import { revalidatePath } from 'next/cache';

import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { enforceRateLimit } from '@/lib/rate-limit';
import { auditActor, type AuditActor } from '@/lib/data/audit';
import {
  getIngredientEquivalencyAnchors,
  getProfileIdentity,
  upsertNutritionProfile,
  type UpsertNutritionProfileInput,
} from '@/lib/data/ingredient-nutrition';
import {
  lookupExternalFoodByBarcodeSchema,
  refreshIngredientNutritionSchema,
  saveIngredientNutritionSchema,
  searchUsdaSchema,
} from '@/lib/validation/ingredient-nutrition';
import { getUsdaFood, searchUsdaFoods, type UsdaFood } from '@/lib/usda/client';
import { normalizeBarcode } from '@/lib/open-food-facts/barcode';
import {
  resolveOffByBarcode,
  type OffResolveResult,
} from '@/lib/open-food-facts/resolve';
import { payloadHash } from '@/lib/data/external-food-cache';
import { convertQuantity } from '@/lib/calculations/uom';
import type { NutrientKey } from '@/lib/calculations/nutrition';
import type { ExternalFoodSnapshot, ExternalFoodQuality } from '@/lib/external-food/types';
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

/**
 * Map a fetched USDA food onto the provider-neutral profile upsert contract.
 * DUAL-WRITE: fills BOTH the legacy `fdc*` identity and the generic
 * `externalId`/`externalSourceType` (plan §6.2). USDA is always per 100 g.
 */
function usdaFoodToProfileInput(food: UsdaFood): UpsertNutritionProfileInput {
  const published = food.publishedDate ? new Date(food.publishedDate) : null;
  return {
    source: 'usda',
    externalId: food.fdcId.toString(),
    externalSourceType: food.dataType,
    barcode: null,
    sourceCountry: null,
    sourceLanguage: null,
    sourceRevision: null,
    normalizationVersion: null,
    sourcePayloadHash: null,
    qualityStatus: null,
    qualityWarnings: null,
    sourceDescription: food.description,
    brandOwner: food.brandOwner,
    sourceUpdatedAt:
      published && !Number.isNaN(published.getTime()) ? published : null,
    basisGrams: 100,
    saltG: null,
    values: food.nutrientsPer100g,
    fdcId: food.fdcId,
    fdcDataType: food.dataType,
  };
}

function revalidateNutritionSurfaces(): void {
  // Profiles feed every recipe's Nutrition tab (derive-on-read).
  revalidatePath('/recipes');
  revalidatePath('/ingredients');
}

// ─────────────────────────── Open Food Facts ────────────────────────────────

type OffFailureReason = Extract<OffResolveResult, { ok: false }>['reason'];

/** Map a provider-implementation reason to a stable product-level error (§14). */
function offReasonToCode(reason: OffFailureReason): ActionErrorCode {
  switch (reason) {
    case 'DISABLED':
      return 'OPEN_FOOD_FACTS_DISABLED';
    case 'NOT_FOUND':
      return 'EXTERNAL_PRODUCT_NOT_FOUND';
    case 'BASIS_UNSUPPORTED':
      return 'NUTRITION_BASIS_UNSUPPORTED';
    case 'NON_FOOD':
    case 'MISSING_NAME':
    case 'INVALID':
      return 'EXTERNAL_PRODUCT_INVALID';
    case 'UNAVAILABLE':
    default:
      return 'OPEN_FOOD_FACTS_UNAVAILABLE';
  }
}

/**
 * Enforce BOTH Open Food Facts limits before any external egress (plan §13):
 * the per-org+user interactive limit and the global application ceiling that
 * protects the shared production IP.
 */
async function enforceOffRateLimits(
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const perUser = await enforceRateLimit(
    getDb(),
    'openFoodFactsRead',
    `${organizationId}:${userId}`,
  );
  if (!perUser.allowed) return false;
  const global = await enforceRateLimit(getDb(), 'openFoodFactsGlobal', 'global');
  return global.allowed;
}

/** Snapshot → profile upsert contract for an Open Food Facts save. */
function offSnapshotToProfileInput(
  snapshot: ExternalFoodSnapshot,
  basisGrams: number,
): UpsertNutritionProfileInput {
  return {
    source: 'open_food_facts',
    externalId: snapshot.externalId,
    externalSourceType: null,
    barcode: snapshot.barcode,
    sourceCountry: snapshot.sourceCountry,
    sourceLanguage: snapshot.sourceLanguage,
    sourceRevision: snapshot.sourceRevision,
    normalizationVersion: snapshot.normalizationVersion,
    sourcePayloadHash: payloadHash(snapshot),
    qualityStatus: snapshot.qualityStatus,
    qualityWarnings: snapshot.qualityWarnings,
    sourceDescription: snapshot.description,
    brandOwner: snapshot.brandOwner,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    basisGrams,
    saltG: snapshot.saltG,
    values: snapshot.nutrients,
    fdcId: null,
    fdcDataType: null,
  };
}

/**
 * Serializable preview for the packaged-product tab (plan §15). Dates are ISO
 * strings so the value crosses the action boundary cleanly.
 */
export type ExternalFoodPreview = {
  provider: 'open_food_facts';
  externalId: string;
  barcode: string | null;
  description: string;
  brandOwner: string | null;
  packageQuantity: string | null;
  sourceCountry: string | null;
  sourceLanguage: string | null;
  sourceUpdatedAt: string | null;
  basisUnit: 'g' | 'ml';
  nutrients: Record<NutrientKey, number | null>;
  saltG: number | null;
  derivedFields: NutrientKey[];
  qualityStatus: ExternalFoodQuality;
  qualityWarnings: string[];
  /** Served from stale cache because the provider was unavailable. */
  stale: boolean;
  /** Per-100 ml product on an ingredient with no weight equivalency (save blocked). */
  requiresEquivalency: boolean;
};

function snapshotToPreview(
  snapshot: ExternalFoodSnapshot,
  stale: boolean,
  requiresEquivalency: boolean,
): ExternalFoodPreview {
  return {
    provider: 'open_food_facts',
    externalId: snapshot.externalId,
    barcode: snapshot.barcode,
    description: snapshot.description,
    brandOwner: snapshot.brandOwner,
    packageQuantity: snapshot.packageQuantity,
    sourceCountry: snapshot.sourceCountry,
    sourceLanguage: snapshot.sourceLanguage,
    sourceUpdatedAt: snapshot.sourceUpdatedAt
      ? snapshot.sourceUpdatedAt.toISOString()
      : null,
    basisUnit: snapshot.basis.unit,
    nutrients: snapshot.nutrients,
    saltG: snapshot.saltG,
    derivedFields: snapshot.derivedFields,
    qualityStatus: snapshot.qualityStatus,
    qualityWarnings: snapshot.qualityWarnings,
    stale,
    requiresEquivalency,
  };
}

/**
 * Exact Open Food Facts barcode lookup for the packaged-product tab. Validates
 * the barcode locally, rate-limits BOTH the per-user and global buckets, then
 * resolves via cache/provider and returns a preview — it never writes a profile.
 */
export async function lookupExternalFoodByBarcodeAction(
  input: unknown,
): Promise<ActionResult<{ preview: ExternalFoodPreview }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = lookupExternalFoodByBarcodeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  const barcode = normalizeBarcode(parsed.data.barcode);
  if (!barcode.ok) return { ok: false, code: 'INVALID_BARCODE' };
  try {
    const organizationId = await getOrgId();
    const userId = await getUserId();
    if (!(await enforceOffRateLimits(organizationId, userId))) {
      return { ok: false, code: 'RATE_LIMITED' };
    }

    const resolved = await resolveOffByBarcode(getDb(), barcode.code);
    if (!resolved.ok) return { ok: false, code: offReasonToCode(resolved.reason) };

    // A per-100 ml product needs the ingredient's weight equivalency to save.
    let requiresEquivalency = false;
    if (resolved.snapshot.basis.unit === 'ml') {
      const anchors = await withOrg(organizationId, (tx) =>
        getIngredientEquivalencyAnchors(tx, organizationId, parsed.data.ingredientId),
      );
      requiresEquivalency = !offCanConvertMlToGrams(anchors);
    }

    return {
      ok: true,
      data: {
        preview: snapshotToPreview(resolved.snapshot, resolved.stale, requiresEquivalency),
      },
    };
  } catch (error) {
    return unexpected('lookupExternalFoodByBarcodeAction', error);
  }
}

/** Convert a per-100 ml basis to grams via the ingredient anchors (plan §10). */
function offMlBasisToGrams(
  anchors: Awaited<ReturnType<typeof getIngredientEquivalencyAnchors>>,
): number | null {
  if (!anchors) return null;
  const converted = convertQuantity(100, 'ml', 'weight', anchors);
  return converted.ok && converted.canonical > 0 ? converted.canonical : null;
}

function offCanConvertMlToGrams(
  anchors: Awaited<ReturnType<typeof getIngredientEquivalencyAnchors>>,
): boolean {
  return offMlBasisToGrams(anchors) !== null;
}

/**
 * Save (or refresh) an Open Food Facts profile: server RE-RESOLVES the product
 * by barcode (client nutrient values are never trusted), gates on partial
 * confirmation and the 100 ml basis/equivalency, then locks + UPSERTs atomically.
 */
async function saveOffProfile(
  organizationId: string,
  userId: string,
  actor: AuditActor,
  ingredientId: string,
  rawBarcode: string,
  confirmPartial: boolean,
  opts: { refreshed?: boolean } = {},
): Promise<ActionResult<{ profile: IngredientNutritionProfile }>> {
  const barcode = normalizeBarcode(rawBarcode);
  if (!barcode.ok) return { ok: false, code: 'INVALID_BARCODE' };
  if (!(await enforceOffRateLimits(organizationId, userId))) {
    return { ok: false, code: 'RATE_LIMITED' };
  }
  const resolved = await resolveOffByBarcode(getDb(), barcode.code, {
    forceRefresh: opts.refreshed,
  });
  if (!resolved.ok) return { ok: false, code: offReasonToCode(resolved.reason) };
  const snapshot = resolved.snapshot;
  // Defensive: normalize never returns an ok rejected snapshot, but never save one.
  if (snapshot.qualityStatus === 'rejected') {
    return { ok: false, code: 'EXTERNAL_PRODUCT_INVALID' };
  }
  if (snapshot.qualityStatus === 'partial' && !confirmPartial) {
    return { ok: false, code: 'EXTERNAL_PRODUCT_PARTIAL' };
  }

  const result = await withOrg(organizationId, async (tx) => {
    let basisGrams = 100;
    if (snapshot.basis.unit === 'ml') {
      const anchors = await getIngredientEquivalencyAnchors(tx, organizationId, ingredientId);
      const grams = offMlBasisToGrams(anchors);
      if (grams === null) return { status: 'equivalency_required' as const };
      basisGrams = grams;
    }
    return upsertNutritionProfile(
      tx,
      organizationId,
      ingredientId,
      offSnapshotToProfileInput(snapshot, basisGrams),
      actor,
      opts,
    );
  });
  if (result.status === 'equivalency_required') {
    return { ok: false, code: 'NUTRITION_EQUIVALENCY_REQUIRED' };
  }
  if (result.status !== 'done') return { ok: false, code: 'NOT_FOUND' };
  revalidateNutritionSurfaces();
  return { ok: true, data: { profile: result.profile } };
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
    const ingredientId = parsed.data.ingredientId;

    if (parsed.data.source === 'open_food_facts') {
      const userId = await getUserId();
      return await saveOffProfile(
        organizationId,
        userId,
        actor,
        ingredientId,
        parsed.data.barcode,
        parsed.data.confirmPartial ?? false,
      );
    }

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
        externalId: null,
        externalSourceType: null,
        barcode: null,
        sourceCountry: null,
        sourceLanguage: null,
        sourceRevision: null,
        normalizationVersion: null,
        sourcePayloadHash: null,
        qualityStatus: null,
        qualityWarnings: null,
        sourceDescription: null,
        brandOwner: null,
        sourceUpdatedAt: null,
        basisGrams: 100,
        saltG: null,
        values: parsed.data.values,
        fdcId: null,
        fdcDataType: null,
      };
    }

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
      getProfileIdentity(tx, organizationId, ingredientId),
    );
    // Refresh dispatches by the STORED provider identity (plan §14), preserving
    // provider + attribution — a USDA profile refreshes from USDA, an Open Food
    // Facts profile from OFF; a custom/missing profile has nothing to refresh.
    if (!identity) return { ok: false, code: 'NOT_FOUND' };
    const userId = await getUserId();

    if (identity.provider === 'open_food_facts') {
      // A refresh keeps the same product; a partial one may re-save silently.
      return await saveOffProfile(
        organizationId,
        userId,
        actor,
        ingredientId,
        identity.barcode,
        true,
        { refreshed: true },
      );
    }

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
