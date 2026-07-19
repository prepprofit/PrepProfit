import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TenantClient } from '@/lib/db';
import { ingredientAllergens, ingredients, type Ingredient } from '@/lib/db/schema';
import type { CatalogEntry } from '@/lib/ingredient-catalog/schema';

/**
 * Data layer for creating an ingredient from the seed catalogue
 * (docs/ingredient-seed-catalog-plan.md §3). HARD RULES:
 *  - priceCents = 0 and needsPricing = true ALWAYS — a price never comes from
 *    the catalogue, whatever the caller passes.
 *  - Typical allergens are inserted WITHOUT stamping the review provenance
 *    (allergens_reviewed_at stays NULL), so they surface as unreviewed.
 *  - Duplicate ACTIVE name in the org (case-insensitive) is blocked (D4).
 * RULE #1: every statement is org-scoped and runs inside the caller's withOrg.
 */

export type CreateFromCatalogResult =
  | { status: 'created'; ingredient: Ingredient }
  | { status: 'duplicate'; existingId: string };

export async function createIngredientFromCatalog(
  tx: TenantClient,
  organizationId: string,
  entry: CatalogEntry,
  overrides: { name: string; dimension: Ingredient['dimension'] },
): Promise<CreateFromCatalogResult> {
  const name = overrides.name.trim();

  const [existing] = await tx
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNull(ingredients.deletedAt),
        sql`lower(${ingredients.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  if (existing) return { status: 'duplicate', existingId: existing.id };

  const [created] = await tx
    .insert(ingredients)
    .values({
      organizationId,
      name,
      dimension: overrides.dimension,
      priceCents: 0,
      needsPricing: true,
      suggestedFdcId: entry.suggestedFdcId,
    })
    .returning();
  if (!created) throw new Error('Failed to create ingredient from catalog.');

  if (entry.allergens.length > 0) {
    await tx.insert(ingredientAllergens).values(
      entry.allergens.map((tag) => ({
        organizationId,
        ingredientId: created.id,
        allergen: tag.allergen,
        presence: tag.presence,
      })),
    );
    // Deliberately NOT stamping allergensReviewedAt/By: seeded tags are
    // "typical, unreviewed" until a human runs the normal review flow.
  }

  return { status: 'created', ingredient: created };
}
