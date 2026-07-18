import { and, eq, inArray } from 'drizzle-orm';

import {
  ingredientNutritionProfiles,
  type IngredientNutritionProfile,
} from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import { lockActiveIngredient } from '@/lib/data/ingredients';
import { NUTRIENT_KEYS, type NutrientKey } from '@/lib/calculations/nutrition';
import type { NutrientValuesInput } from '@/lib/validation/ingredient-nutrition';

/**
 * Ingredient nutrition data layer (Recipes 2.0 Fase 6, plan §6.7). ONE active
 * profile per ingredient (DB unique) — writes are UPSERTs under the active
 * ingredient's FOR UPDATE lock, so concurrent saves serialize and a trashed
 * ingredient can't gain a profile. Every mutation is audited inside the
 * caller's `withOrg` transaction; metadata carries ids/source only, never
 * nutrient values (they're not PII, but the audit contract stays descriptors-
 * only). Reads are BATCH ONLY (`getProfilesForIngredients`) — never N+1.
 */

export type UpsertNutritionProfileInput = {
  source: 'usda' | 'custom';
  /** USDA source metadata; all null for custom profiles. */
  fdcId: number | null;
  fdcDataType: string | null;
  sourceDescription: string | null;
  brandOwner: string | null;
  /** Source publication date, when USDA provides one. */
  sourceUpdatedAt: Date | null;
  values: NutrientValuesInput;
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

/** The 17 nutrient columns as an update/insert fragment. */
function nutrientColumns(
  values: NutrientValuesInput,
): Record<NutrientKey, number | null> {
  const out = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) out[k] = values[k];
  return out;
}

/**
 * Create or replace the ingredient's profile (per-100 g contract). The
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
  const [row] = await db
    .insert(ingredientNutritionProfiles)
    .values({
      organizationId,
      ingredientId,
      source: input.source,
      fdcId: input.fdcId,
      fdcDataType: input.fdcDataType,
      sourceDescription: input.sourceDescription,
      brandOwner: input.brandOwner,
      basisGrams: 100,
      sourceUpdatedAt: input.sourceUpdatedAt,
      refreshedAt: input.source === 'usda' ? now : null,
      updatedBy: actor.userId,
      ...nutrientColumns(input.values),
    })
    .onConflictDoUpdate({
      target: [
        ingredientNutritionProfiles.organizationId,
        ingredientNutritionProfiles.ingredientId,
      ],
      set: {
        source: input.source,
        fdcId: input.fdcId,
        fdcDataType: input.fdcDataType,
        sourceDescription: input.sourceDescription,
        brandOwner: input.brandOwner,
        basisGrams: 100,
        sourceUpdatedAt: input.sourceUpdatedAt,
        refreshedAt: input.source === 'usda' ? now : null,
        updatedBy: actor.userId,
        updatedAt: now,
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
    metadata: {
      ingredientId,
      source: input.source,
      fdcId: input.fdcId,
    },
  });
  return { status: 'done', profile: row };
}

/**
 * The stored USDA identity of an ingredient's profile, needed by `Refresh
 * from source` — returns null for custom/missing profiles.
 */
export async function getUsdaProfileIdentity(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<{ fdcId: number } | null> {
  const map = await getProfilesForIngredients(db, organizationId, [ingredientId]);
  const profile = map.get(ingredientId);
  if (!profile || profile.source !== 'usda' || profile.fdcId == null) return null;
  return { fdcId: profile.fdcId };
}
