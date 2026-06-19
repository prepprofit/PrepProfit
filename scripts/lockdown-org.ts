import { ensureOrgLockdown } from '../lib/org/lockdown';

/**
 * One-off retrofit for the org self-delete lockdown (Sprint 4e).
 *
 * New orgs are locked down automatically (via the `organization.created` webhook
 * and the onboarding safety net). EXISTING orgs created before the lockdown are
 * NOT auto-retrofitted, so run this once per existing org AFTER the Clerk side is
 * configured (custom `org:owner` role + system user) and `CLERK_SYSTEM_USER_ID`
 * is set in the environment.
 *
 * It reserves the system user as the org's `org:admin` and demotes every human
 * admin to the delete-less `org:owner` role. Idempotent and fail-safe: it no-ops
 * (and logs) when `CLERK_SYSTEM_USER_ID` is unset, and never throws.
 *
 * Usage:
 *   LOCKDOWN_ORG=org_xxx npx tsx scripts/lockdown-org.ts
 *   npx tsx scripts/lockdown-org.ts org_xxx
 */

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // optional when the vars are already in the environment
  }
}

const ORG = process.env.LOCKDOWN_ORG ?? process.argv[2];

async function main() {
  loadEnv();
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error('CLERK_SECRET_KEY is not set (see SETUP.md).');
  }
  if (!process.env.CLERK_SYSTEM_USER_ID) {
    throw new Error(
      'CLERK_SYSTEM_USER_ID is not set — configure the Clerk system user first ' +
        '(see SETUP.md), otherwise the lockdown is a no-op.',
    );
  }
  if (!ORG) {
    throw new Error(
      'Set LOCKDOWN_ORG=<clerk org id> (or pass it as the first argument).',
    );
  }

  console.log(`▶ Locking down org ${ORG} (reserve system admin + demote creator)...`);
  await ensureOrgLockdown(ORG);
  console.log(`✓ Lockdown ensured for org ${ORG}. Verify roles in the Clerk dashboard.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
