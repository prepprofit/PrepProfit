import { getDb, withOrg } from '../lib/db';
import { listRecipeOrgIds } from '../lib/db/org-enumeration';
import {
  backfillRecipesV2ForOrg,
  type RecipesV2BackfillStats,
} from '../lib/data/recipes-v2-backfill';

/**
 * Recipes 2.0 backfill driver (Meez-parity plan, Release A) — folders → books,
 * folder memberships → book entries, chef-facing yield from portions, and the
 * "Default serving" portion option. Run with: `npm run backfill:recipes-v2`
 * (every org that has recipe data, enumerated FROM THE DATABASE) or
 * `BACKFILL_ORG=org_xxx npm run backfill:recipes-v2` (one org).
 *
 * Org discovery is DB-driven (not Clerk): the Neon owner role bypasses RLS, so
 * `listRecipeOrgIds` sees every org's data. This closes the gap where a
 * mismatched CLERK_SECRET_KEY made the backfill cover only some prod orgs.
 *
 * The per-org transform (idempotent) lives in lib/data/recipes-v2-backfill.ts.
 * This driver is RLS-SAFE: it runs each org inside `withOrg`.
 */

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // optional when DATABASE_URL is already in the environment
  }
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (see SETUP.md).');
  }

  const single = process.env.BACKFILL_ORG ?? process.argv[2];
  const orgIds = single ? [single] : await listRecipeOrgIds(getDb());

  if (orgIds.length === 0) {
    console.error(
      '✗ No orgs found with recipe data. If the DB is not empty, the role ' +
        'cannot read across orgs (BYPASSRLS required) — aborting.',
    );
    process.exit(1);
  }

  const totals: RecipesV2BackfillStats & { orgs: number } = {
    orgs: 0,
    booksCreated: 0,
    membershipsCreated: 0,
    yieldsBackfilled: 0,
    portionOptionsCreated: 0,
  };

  console.log(`▶ Backfilling Recipes 2.0 data for ${orgIds.length} org(s)...`);
  for (const orgId of orgIds) {
    const s = await withOrg(orgId, (tx) => backfillRecipesV2ForOrg(tx, orgId));
    totals.orgs += 1;
    totals.booksCreated += s.booksCreated;
    totals.membershipsCreated += s.membershipsCreated;
    totals.yieldsBackfilled += s.yieldsBackfilled;
    totals.portionOptionsCreated += s.portionOptionsCreated;
    console.log(`  ${orgId}:`, s);
  }

  console.log('✓ Recipes 2.0 backfill complete:', totals);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
