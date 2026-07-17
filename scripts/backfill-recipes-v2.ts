import { createClerkClient } from '@clerk/backend';
import { withOrg } from '../lib/db';
import {
  backfillRecipesV2ForOrg,
  type RecipesV2BackfillStats,
} from '../lib/data/recipes-v2-backfill';

/**
 * Recipes 2.0 backfill driver (Meez-parity plan, Release A) — folders → books,
 * folder memberships → book entries, chef-facing yield from portions, and the
 * "Default serving" portion option. Run with: `npm run backfill:recipes-v2`
 * (all orgs via Clerk) or `BACKFILL_ORG=org_xxx npm run backfill:recipes-v2`
 * (one org).
 *
 * The per-org transform (idempotent) lives in lib/data/recipes-v2-backfill.ts.
 * This driver is RLS-SAFE: it fans out over Clerk orgs and runs each inside
 * `withOrg` (the same pattern as scripts/backfill-suppliers.ts).
 */

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // optional when DATABASE_URL is already in the environment
  }
}

const PAGE_SIZE = 100;

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (see SETUP.md).');
  }

  const single = process.env.BACKFILL_ORG ?? process.argv[2];
  const totals: RecipesV2BackfillStats & { orgs: number } = {
    orgs: 0,
    booksCreated: 0,
    membershipsCreated: 0,
    yieldsBackfilled: 0,
    portionOptionsCreated: 0,
  };
  const accumulate = (s: RecipesV2BackfillStats) => {
    totals.orgs += 1;
    totals.booksCreated += s.booksCreated;
    totals.membershipsCreated += s.membershipsCreated;
    totals.yieldsBackfilled += s.yieldsBackfilled;
    totals.portionOptionsCreated += s.portionOptionsCreated;
  };

  if (single) {
    console.log(`▶ Backfilling Recipes 2.0 data for ${single}...`);
    accumulate(
      await withOrg(single, (tx) => backfillRecipesV2ForOrg(tx, single)),
    );
  } else {
    console.log('▶ Backfilling Recipes 2.0 data for every Clerk org...');
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        'CLERK_SECRET_KEY is not set — needed to enumerate orgs (or pass BACKFILL_ORG=org_xxx).',
      );
    }
    const client = createClerkClient({ secretKey });
    let offset = 0;
    for (;;) {
      const { data, totalCount } =
        await client.organizations.getOrganizationList({
          limit: PAGE_SIZE,
          offset,
        });
      if (data.length === 0) break;
      for (const org of data) {
        accumulate(
          await withOrg(org.id, (tx) => backfillRecipesV2ForOrg(tx, org.id)),
        );
      }
      offset += data.length;
      if (offset >= totalCount) break;
    }
  }

  console.log('✓ Recipes 2.0 backfill complete:', totals);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
