import { and, eq, isNull } from 'drizzle-orm';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import type { TenantClient } from '@/lib/db/tenant';
import { ingredients, aiExtractionAttempts } from '@/lib/db/schema';
import { countActiveRecipes } from '@/lib/data/recipes';

/**
 * Activation read model for Flows onboarding properties (flows-onboarding plan §4). One
 * cheap, org-scoped snapshot of "has the org done the first activation steps yet" — sent
 * to Flows as coarse booleans/counts for checklist completion and targeting. It loads NO
 * full lists (just a count + two existence probes), carries no money or names, and is
 * server-only (never exposed through an API route).
 *
 * RULE #1: the org id is derived server-side ({@link getOrgId}) and every read runs inside
 * `withOrg`, so RLS is the second layer.
 */
export type ActivationSnapshot = {
  /** Active, non-trashed recipes for the org. */
  recipeCount: number;
  /** Org has at least one active, non-trashed ingredient. */
  hasIngredient: boolean;
  /** Org has at least one LIFETIME succeeded photo extraction (any month). */
  hasRunPhotoExtraction: boolean;
};

/** True when the org has at least one active (non-soft-deleted) ingredient. */
export async function hasActiveIngredient(
  db: TenantClient,
  organizationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(eq(ingredients.organizationId, organizationId), isNull(ingredients.deletedAt)),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * True when the org has EVER had a succeeded photo extraction. Deliberately NOT scoped to
 * the current month — onboarding activation should not reset with the monthly usage meter
 * (plan §4), so this must not reuse `getPhotoExtractionUsageSummaryThisMonth()`.
 */
export async function hasSucceededPhotoExtraction(
  db: TenantClient,
  organizationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: aiExtractionAttempts.id })
    .from(aiExtractionAttempts)
    .where(
      and(
        eq(aiExtractionAttempts.organizationId, organizationId),
        eq(aiExtractionAttempts.status, 'succeeded'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The three activation reads over an already-open tenant client (testable directly). */
export async function readActivationSnapshot(
  db: TenantClient,
  organizationId: string,
): Promise<ActivationSnapshot> {
  const [recipeCount, hasIngredient, hasRunPhotoExtraction] = await Promise.all([
    countActiveRecipes(db, organizationId),
    hasActiveIngredient(db, organizationId),
    hasSucceededPhotoExtraction(db, organizationId),
  ]);
  return { recipeCount, hasIngredient, hasRunPhotoExtraction };
}

/**
 * Activation snapshot for the active org — resolves the org id server-side and runs the
 * reads inside one `withOrg` transaction. Called by the authenticated app layout to feed
 * the Flows user properties.
 */
export async function getActivationSnapshot(): Promise<ActivationSnapshot> {
  const organizationId = await getOrgId();
  return withOrg(organizationId, (tx) => readActivationSnapshot(tx, organizationId));
}
