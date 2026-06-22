import { createClerkClient } from '@clerk/backend';
import { withOrg } from '../lib/db';
import {
  backfillSuppliersForOrg,
  type SupplierBackfillStats,
} from '../lib/data/supplier-backfill';

/**
 * Sprint 7 supplier backfill — turn the legacy free-text `ingredients.supplier`
 * column into real `suppliers` rows + DEFAULT `ingredient_suppliers` links, once
 * per environment. Run with: `npm run backfill:suppliers` (all orgs via Clerk) or
 * `BACKFILL_ORG=org_xxx npm run backfill:suppliers` (one org).
 *
 * The per-org transform (idempotent) lives in lib/data/supplier-backfill.ts. This
 * driver is RLS-SAFE: it never assumes the owner bypasses FORCE RLS — it fans out
 * over Clerk orgs and runs each inside `withOrg` (the cron-purge pattern).
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
  const totals: SupplierBackfillStats & { orgs: number } = {
    orgs: 0,
    suppliersCreated: 0,
    linksCreated: 0,
    linksKept: 0,
    legacySynced: 0,
  };
  const accumulate = (s: SupplierBackfillStats) => {
    totals.orgs += 1;
    totals.suppliersCreated += s.suppliersCreated;
    totals.linksCreated += s.linksCreated;
    totals.linksKept += s.linksKept;
    totals.legacySynced += s.legacySynced;
  };

  if (single) {
    console.log(`▶ Backfilling suppliers for ${single}...`);
    accumulate(await withOrg(single, (tx) => backfillSuppliersForOrg(tx, single)));
  } else {
    console.log('▶ Backfilling suppliers for every Clerk org...');
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        'CLERK_SECRET_KEY is not set — needed to enumerate orgs (or pass BACKFILL_ORG=org_xxx).',
      );
    }
    const client = createClerkClient({ secretKey });
    let offset = 0;
    for (;;) {
      const { data, totalCount } = await client.organizations.getOrganizationList({
        limit: PAGE_SIZE,
        offset,
      });
      if (data.length === 0) break;
      for (const org of data) {
        accumulate(await withOrg(org.id, (tx) => backfillSuppliersForOrg(tx, org.id)));
      }
      offset += data.length;
      if (offset >= totalCount) break;
    }
  }

  console.log('✓ Supplier backfill complete:', totals);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
