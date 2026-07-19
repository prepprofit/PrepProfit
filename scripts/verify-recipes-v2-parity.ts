import { getDb, withOrg } from '../lib/db';
import { listRecipeOrgIds } from '../lib/db/org-enumeration';
import {
  checkRecipesV2Parity,
  parityReportIsClean,
} from '../lib/data/recipes-v2-parity';

/**
 * Recipes 2.0 parity VERIFIER (Fase 7 Slice 6) — READ-ONLY. Run with:
 * `npm run verify:recipes-v2` (every org that has recipe data, enumerated
 * FROM THE DATABASE) or `VERIFY_ORG=org_xxx npm run verify:recipes-v2` (one).
 *
 * Org discovery is DB-driven (not Clerk): the Neon owner role bypasses RLS, so
 * `listRecipeOrgIds` sees every org's data. This closes the gap where a
 * mismatched CLERK_SECRET_KEY made the check cover only some prod orgs.
 *
 * Exit 0 = every org is clean → safe to trust the portion-option price as the
 * sole source. Exit 1 = divergences printed per org (fix buckets 1/3 by
 * re-running the idempotent backfill; bucket 2 — a default option left unpriced
 * while the legacy column has a price — needs a price decision).
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

  const single = process.env.VERIFY_ORG ?? process.argv[2];
  const orgIds = single ? [single] : await listRecipeOrgIds(getDb());

  if (orgIds.length === 0) {
    // A cross-org read returning nothing means either an empty DB or — the
    // dangerous case — a DB role that CANNOT bypass RLS. Never claim "safe".
    console.error(
      '✗ No orgs found with recipe data. If the DB is not empty, the role ' +
        'cannot read across orgs (BYPASSRLS required) — aborting without a verdict.',
    );
    process.exit(1);
  }

  console.log(`▶ Verifying Recipes 2.0 parity for ${orgIds.length} org(s)...`);
  let dirtyOrgs = 0;
  for (const orgId of orgIds) {
    const report = await withOrg(orgId, (tx) =>
      checkRecipesV2Parity(tx, orgId),
    );
    if (parityReportIsClean(report)) continue;
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
  }

  if (dirtyOrgs > 0) {
    console.log(
      `✗ Parity check FAILED: ${dirtyOrgs}/${orgIds.length} org(s) diverge.`,
    );
    process.exit(1);
  }
  console.log(
    `✓ Parity clean across ${orgIds.length} org(s) — option price is the sole source.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
