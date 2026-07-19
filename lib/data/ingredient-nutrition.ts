import { and, eq, inArray } from 'drizzle-orm';

import {
  ingredientNutritionProfiles,
  ingredientUomEquivalencies,
  type IngredientNutritionProfile,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import type { UomAnchors } from '@/lib/calculations/uom';
import { writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import { lockActiveIngredient } from '@/lib/data/ingredients';
import { NUTRIENT_KEYS, type NutrientKey } from '@/lib/calculations/nutrition';
import type { NutrientValuesInput } from '@/lib/validation/ingredient-nutrition';
import type {
  ExternalFoodQuality,
  NutritionProviderId,
  NutritionSourceType,
} from '@/lib/external-food/types';

/**
 * Ingredient nutrition data layer (Recipes 2.0 Fase 6; generalized for the Open
 * Food Facts integration, plan §6/§14). ONE active profile per ingredient (DB
 * unique) — writes are UPSERTs under the active ingredient's FOR UPDATE lock, so
 * concurrent saves serialize and a trashed ingredient can't gain a profile.
 *
 * DUAL-WRITE during the migration (plan §6.2): a USDA save writes BOTH the legacy
 * `fdc_id`/`fdc_data_type` columns AND the provider-neutral
 * `external_source_id`/`external_source_type` identity. A later cleanup PR drops
 * the legacy columns once production has validated the generic identity.
 *
 * Every mutation is audited inside the caller's `withOrg` transaction; metadata
 * carries provider/identity/quality descriptors only, NEVER nutrient values.
 * Reads are BATCH ONLY (`getProfilesForIngredients`) — never N+1.
 */

export type UpsertNutritionProfileInput = {
  source: NutritionSourceType;
  /** Provider-neutral identity: `fdc_id::text` or the normalized GTIN; null for custom. */
  externalId: string | null;
  /** USDA data type or provider-specific subtype; null for custom. */
  externalSourceType: string | null;
  /** Normalized product code (barcode providers only). */
  barcode: string | null;
  sourceCountry: string | null;
  sourceLanguage: string | null;
  sourceRevision: string | null;
  normalizationVersion: number | null;
  sourcePayloadHash: string | null;
  qualityStatus: ExternalFoodQuality | null;
  qualityWarnings: string[] | null;
  sourceDescription: string | null;
  brandOwner: string | null;
  /** Source publication/last-modified time, when the provider gives one. */
  sourceUpdatedAt: Date | null;
  /** Reference mass the nutrient values describe (100 for per-100 g/ml-in-g). */
  basisGrams: number;
  /** European salt per basis (g); null = unknown. */
  saltG: number | null;
  values: NutrientValuesInput;
  /** Legacy USDA identity — dual-written for backward compatibility. */
  fdcId: number | null;
  fdcDataType: string | null;
};

export type NutritionProfileResult =
  | { status: 'done'; profile: IngredientNutritionProfile }
  | { status: 'not_found' };

/** Batch-load the active profiles for a set of ingredients (single query). */
export async function getProfilesForIngredients(
  db: TenantClient,
  organizationId: string,
  ingredientIds: string[],
): Promise<Map<string, IngredientNutritionProfile>> {
  const map = new Map<string, IngredientNutritionProfile>();
  if (ingredientIds.length === 0) return map;
  const rows = await db
    .select()
    .from(ingredientNutritionProfiles)
    .where(
      and(
        eq(ingredientNutritionProfiles.organizationId, organizationId),
        inArray(ingredientNutritionProfiles.ingredientId, [
          ...new Set(ingredientIds),
        ]),
      ),
    );
  for (const row of rows) map.set(row.ingredientId, row);
  return map;
}

/** The 16 nutrient columns as an update/insert fragment. */
function nutrientColumns(
  values: NutrientValuesInput,
): Record<NutrientKey, number | null> {
  const out = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) out[k] = values[k];
  return out;
}

/** All provider/quality/identity columns written on both insert and update. */
function metadataColumns(input: UpsertNutritionProfileInput, now: Date) {
  return {
    source: input.source,
    fdcId: input.fdcId,
    fdcDataType: input.fdcDataType,
    externalSourceId: input.externalId,
    externalSourceType: input.externalSourceType,
    barcode: input.barcode,
    sourceCountry: input.sourceCountry,
    sourceLanguage: input.sourceLanguage,
    sourceRevision: input.sourceRevision,
    normalizationVersion: input.normalizationVersion,
    sourcePayloadHash: input.sourcePayloadHash,
    qualityStatus: input.qualityStatus,
    qualityWarnings: input.qualityWarnings,
    sourceDescription: input.sourceDescription,
    brandOwner: input.brandOwner,
    basisGrams: input.basisGrams,
    saltG: input.saltG,
    sourceUpdatedAt: input.sourceUpdatedAt,
    // An external provider (usda/open_food_facts) stamps a fetch time; a manual
    // profile never does.
    refreshedAt: input.source === 'custom' ? null : now,
  };
}

/**
 * Create or replace the ingredient's profile (per-basis contract). The
 * ingredient must be ACTIVE — a trashed/foreign id returns `not_found` before
 * any write. `refreshed` distinguishes an explicit `Refresh from source` from
 * a plain save in the audit trail.
 */
export async function upsertNutritionProfile(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  input: UpsertNutritionProfileInput,
  actor: AuditActor,
  opts: { refreshed?: boolean } = {},
): Promise<NutritionProfileResult> {
  if (!(await lockActiveIngredient(db, organizationId, ingredientId))) {
    return { status: 'not_found' };
  }
  const now = new Date();
  const metadata = metadataColumns(input, now);
  const [row] = await db
    .insert(ingredientNutritionProfiles)
    .values({
      organizationId,
      ingredientId,
      updatedBy: actor.userId,
      ...metadata,
      ...nutrientColumns(input.values),
    })
    .onConflictDoUpdate({
      target: [
        ingredientNutritionProfiles.organizationId,
        ingredientNutritionProfiles.ingredientId,
      ],
      set: {
        updatedBy: actor.userId,
        updatedAt: now,
        ...metadata,
        ...nutrientColumns(input.values),
      },
    })
    .returning();
  if (!row) return { status: 'not_found' };
  await writeAuditEvent(db, organizationId, actor, {
    action: opts.refreshed
      ? 'ingredient.nutritionRefresh'
      : 'ingredient.nutritionSave',
    entityType: 'ingredient_nutrition_profile',
    entityId: row.id,
    // Descriptors only — provider identity + quality, never nutrient values.
    metadata: {
      ingredientId,
      source: input.source,
      externalId: input.externalId,
      qualityStatus: input.qualityStatus,
      normalizationVersion: input.normalizationVersion,
    },
  });
  return { status: 'done', profile: row };
}

/**
 * Provider-neutral identity of an ingredient's profile, needed by `Refresh from
 * source` to dispatch to the right provider (plan §14). Returns null for
 * custom/missing profiles. Dual-READ: prefers the generic `external_source_id`,
 * falling back to legacy `fdc_id` for USDA rows written before the backfill.
 */
export type ProfileIdentity =
  | { provider: 'usda'; externalId: string; fdcId: number }
  | { provider: 'open_food_facts'; externalId: string; barcode: string };

export async function getProfileIdentity(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<ProfileIdentity | null> {
  const map = await getProfilesForIngredients(db, organizationId, [ingredientId]);
  const profile = map.get(ingredientId);
  if (!profile) return null;

  if (profile.source === 'usda') {
    const externalId = profile.externalSourceId ?? profile.fdcId?.toString() ?? null;
    const fdcId = profile.fdcId ?? (externalId ? Number(externalId) : null);
    if (externalId === null || fdcId === null || !Number.isInteger(fdcId)) {
      return null;
    }
    return { provider: 'usda', externalId, fdcId };
  }

  if (profile.source === 'open_food_facts') {
    const barcode = profile.barcode ?? profile.externalSourceId ?? null;
    if (!barcode) return null;
    return {
      provider: 'open_food_facts',
      externalId: profile.externalSourceId ?? barcode,
      barcode,
    };
  }

  return null;
}

/**
 * The ingredient's base weight/volume equivalency anchors, needed to convert a
 * per-100 ml provider basis into grams (plan §10). Returns null when the
 * ingredient has no equivalency — the caller then blocks the save with
 * `NUTRITION_EQUIVALENCY_REQUIRED` (100 ml is NEVER assumed to weigh 100 g).
 */
export async function getIngredientEquivalencyAnchors(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<UomAnchors | null> {
  const [row] = await db
    .select({
      weightGrams: ingredientUomEquivalencies.weightGrams,
      volumeMl: ingredientUomEquivalencies.volumeMl,
      eachCount: ingredientUomEquivalencies.eachCount,
    })
    .from(ingredientUomEquivalencies)
    .where(
      and(
        eq(ingredientUomEquivalencies.organizationId, organizationId),
        eq(ingredientUomEquivalencies.ingredientId, ingredientId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    weightGrams: row.weightGrams,
    volumeMl: row.volumeMl,
    eachCount: row.eachCount,
  };
}

/** Provider of an ingredient's active profile, or null. */
export function providerOfProfile(
  profile: IngredientNutritionProfile,
): NutritionProviderId | null {
  return profile.source === 'usda' || profile.source === 'open_food_facts'
    ? profile.source
    : null;
}
