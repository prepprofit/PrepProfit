import { clerkClient } from '@clerk/nextjs/server';
import { serverEnv } from '@/lib/env';
import { logError } from '@/lib/observability';

/**
 * Org self-delete lockdown (Sprint 4e).
 *
 * PrepProfit is one Clerk organization per customer and customers must NOT be able
 * to delete their own org. Clerk forces the *creator* role to always include
 * `org:sys_profile:delete`, so the only server-enforced lockdown is:
 *   1. a reserved internal "system" user is the org's `org:admin` (it holds the
 *      delete permission, so an admin always exists for backend management), and
 *   2. the human creator is demoted to the custom `org:owner` role — all system
 *      permissions EXCEPT `:delete`, so they manage members/billing/profile but
 *      cannot delete the org.
 *
 * Both `org:admin` (the system user) and `org:owner` (the customer) map to the app
 * `manager` role (see lib/auth.ts), so this changes who can delete the org, NOT
 * who can use the app.
 *
 * This function is IDEMPOTENT and FAIL-SAFE:
 *  - It no-ops (logs, never throws) when `CLERK_SYSTEM_USER_ID` is unset, so the
 *    code can ship before the Clerk-side config (system user + `org:owner` role)
 *    exists — sign-up and the webhook hot path are never broken by it.
 *  - It adds/promotes the system admin BEFORE demoting any human admin, so it
 *    never strips the last admin from an org.
 *  - All Clerk Backend API errors are caught and logged; it never throws into the
 *    sign-up / webhook / onboarding paths that invoke it.
 */
export async function ensureOrgLockdown(orgId: string): Promise<void> {
  const systemUserId = serverEnv().CLERK_SYSTEM_USER_ID;
  if (!systemUserId) {
    // Not configured yet (e.g. dev before the system user exists). No-op so the
    // surrounding sign-up / webhook flow keeps working; record it for visibility.
    logError(
      { action: 'ensureOrgLockdown', orgId },
      new Error('CLERK_SYSTEM_USER_ID is not set — skipping org lockdown'),
    );
    return;
  }

  try {
    const client = await clerkClient();

    // Page through memberships (org limit is small, but be defensive).
    const { data: memberships } =
      await client.organizations.getOrganizationMembershipList({
        organizationId: orgId,
        limit: 100,
      });

    const systemMembership = memberships.find(
      (m) => m.publicUserData?.userId === systemUserId,
    );

    // 1. Ensure the system user is a member with role `org:admin` FIRST, so the
    //    org always has an admin before we demote any human admin below.
    if (!systemMembership) {
      await client.organizations.createOrganizationMembership({
        organizationId: orgId,
        userId: systemUserId,
        role: 'org:admin',
      });
    } else if (systemMembership.role !== 'org:admin') {
      await client.organizations.updateOrganizationMembership({
        organizationId: orgId,
        userId: systemUserId,
        role: 'org:admin',
      });
    }

    // 2. Demote every NON-system admin to the delete-less `org:owner` role.
    for (const m of memberships) {
      const userId = m.publicUserData?.userId;
      if (!userId || userId === systemUserId) continue;
      if (m.role === 'org:admin') {
        await client.organizations.updateOrganizationMembership({
          organizationId: orgId,
          userId,
          role: 'org:owner',
        });
      }
    }
  } catch (err) {
    // Never throw into sign-up / webhook / onboarding hot paths.
    logError({ action: 'ensureOrgLockdown', orgId }, err);
  }
}
