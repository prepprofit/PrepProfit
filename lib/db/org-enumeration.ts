import { union } from 'drizzle-orm/pg-core';
import { recipes, recipeFolders, recipePortionOptions } from './schema';
import type { TenantDb } from './tenant';

/**
 * Distinct organization ids that own recipe-domain data, read DIRECTLY from the
 * database — no Clerk dependency (Fase 7 hardening: the Clerk-based enumeration
 * silently missed orgs whenever `.env.local`'s CLERK_SECRET_KEY belonged to a
 * different Clerk instance than the DATABASE_URL, which is exactly how the
 * parity verify once "passed" while covering only 1 of 2 prod orgs).
 *
 * Runs OUTSIDE `withOrg` (no `app.current_org_id` GUC): it needs a DB role that
 * can read across orgs. The Neon owner role (`neondb_owner`, used by the admin
 * scripts + migrations) has BYPASSRLS, so FORCE RLS does not scope it and every
 * org's rows are visible. The runtime app role must NEVER call this — it would
 * see zero rows without the GUC anyway.
 *
 * The UNION covers every table the Recipes 2.0 backfill/verify touch, so no org
 * with folders, recipes, or portion options is missed (an org can have folders
 * but no recipes yet, or vice versa). `union` already dedupes across branches.
 */
export async function listRecipeOrgIds(db: TenantDb): Promise<string[]> {
  const rows = await union(
    db.selectDistinct({ organizationId: recipes.organizationId }).from(recipes),
    db
      .selectDistinct({ organizationId: recipeFolders.organizationId })
      .from(recipeFolders),
    db
      .selectDistinct({ organizationId: recipePortionOptions.organizationId })
      .from(recipePortionOptions),
  );
  return rows.map((r) => r.organizationId);
}
