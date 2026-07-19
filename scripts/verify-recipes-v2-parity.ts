import { createClerkClient } from '@clerk/backend';
import { withOrg } from '../lib/db';
import {
  checkRecipesV2Parity,
  parityReportIsClean,
} from '../lib/data/recipes-v2-parity';

/**
 * Recipes 2.0 parity VERIFIER (Fase 7 Slice 6) — READ-ONLY. Run with:
 * `npm run verify:recipes-v2` (all orgs via Clerk) or
 * `VERIFY_ORG=org_xxx npm run verify:recipes-v2` (one org).
 *
 * Exit 0 = every org is clean → safe to remove the dual-read price fallback.
 * Exit 1 = divergences printed per org (fix = re-run the idempotent backfill
 * for buckets 1/3; bucket 2 needs a manual price decision — the backfill never
 * overwrites an existing option).
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

  const single = process.env.VERIFY_ORG ?? process.argv[2];
  let orgs = 0;
  let dirtyOrgs = 0;

  const verifyOrg = async (orgId: string) => {
    orgs += 1;
    const report = await withOrg(orgId, (tx) => checkRecipesV2Parity(tx, orgId));
    if (parityReportIsClean(report)) return;
    dirtyOrgs += 1;
    console.log(`✗ ${orgId}`);
    if (report.recipesWithoutDefaultOption.length > 0) {
      console.log(
        `  recipes without default option (${report.recipesWithoutDefaultOption.length}):`,
        report.recipesWithoutDefaultOption.join(', '),
      );
    }
    if (report.optionPriceBehindLegacy.length > 0) {
      console.log(
        `  default option unpriced but legacy priced (${report.optionPriceBehindLegacy.length}):`,
        report.optionPriceBehindLegacy.join(', '),
      );
    }
    if (report.foldersWithoutBook.length > 0) {
      console.log(
        `  folders without homonymous book (${report.foldersWithoutBook.length}):`,
        report.foldersWithoutBook.join(', '),
      );
    }
  };

  if (single) {
    console.log(`▶ Verifying Recipes 2.0 parity for ${single}...`);
    await verifyOrg(single);
  } else {
    console.log('▶ Verifying Recipes 2.0 parity for every Clerk org...');
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        'CLERK_SECRET_KEY is not set — needed to enumerate orgs (or pass VERIFY_ORG=org_xxx).',
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
      for (const org of data) await verifyOrg(org.id);
      offset += data.length;
      if (offset >= totalCount) break;
    }
  }

  if (dirtyOrgs > 0) {
    console.log(`✗ Parity check FAILED: ${dirtyOrgs}/${orgs} org(s) diverge.`);
    process.exit(1);
  }
  console.log(`✓ Parity clean across ${orgs} org(s) — fallback removal is safe.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
