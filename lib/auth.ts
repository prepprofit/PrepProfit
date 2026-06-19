import { auth, clerkClient, currentUser } from '@clerk/nextjs/server';

export const USER_ROLES = ['manager', 'kitchen'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * RULE #1 (CLAUDE.md): the `organization_id` ALWAYS comes from the server, via
 * Clerk, never from the client. Throws if there is no active organization — the
 * middleware must ensure the user selects/creates an org before reaching /app.
 */
export async function getOrgId(): Promise<string> {
  const { orgId } = await auth();
  if (!orgId) {
    throw new Error(
      'No active organization. The user must select or create an organization first.',
    );
  }
  return orgId;
}

/** Authenticated user id (throws if not authenticated). */
export async function getUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated.');
  }
  return userId;
}

/**
 * Display name of the active Clerk organization. Used only as a fallback for the
 * document seller header (Sprint 3.5A) when the org has not filled in its
 * `businessName` setting. Returns null if it cannot be resolved — callers must
 * tolerate a missing name. The org id still comes from the server (RULE #1).
 */
export async function getOrgName(): Promise<string | null> {
  const { orgId } = await auth();
  if (!orgId) return null;
  try {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: orgId });
    return org.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Role for the ACTIVE organization, derived from the Clerk org-membership role
 * (`auth().orgRole`) — NOT user-global `publicMetadata`, which would leak manager
 * rights to EVERY org the user belongs to (RULE #1). Maps Clerk's org roles:
 *   - `org:admin`  → `manager` (financials, payroll, invoices, exports, trash)
 *   - `org:owner`  → `manager` (custom Sprint 4e role: a delete-less admin; the
 *     customer's own role after the org self-delete lockdown — see lib/org/lockdown)
 *   - everything else (incl. `org:member` / no active org) → `kitchen`
 * `kitchen` is the safe default (least privilege). The reserved internal
 * `org:admin` (the system user that holds `org:sys_profile:delete`) also maps to
 * manager, so adding `org:owner` is purely additive and backward-compatible.
 */
export async function getUserRole(): Promise<UserRole> {
  const { orgRole } = await auth();
  return orgRole === 'org:admin' || orgRole === 'org:owner'
    ? 'manager'
    : 'kitchen';
}

export async function isManager(): Promise<boolean> {
  return (await getUserRole()) === 'manager';
}

/**
 * Best-effort first name of the signed-in user, for greetings only. Wrapped in
 * try/catch like {@link getOrgName}: `currentUser()` is a Clerk Backend API call
 * (not the local session) and can fail transiently, so a cosmetic greeting must
 * never crash the page. Returns null on any failure or when unavailable.
 */
export async function getFirstName(): Promise<string | null> {
  try {
    const user = await currentUser();
    const name = user?.firstName?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

/**
 * Pure role predicate — financial modules (income/expenses, dashboards,
 * break-even) are manager-only; kitchen staff are blocked from both the routes
 * and the Server Actions. Kept pure so it is unit-testable without Clerk; the
 * async {@link isManager} is the runtime gate.
 */
export function canAccessFinancials(role: UserRole): boolean {
  return role === 'manager';
}
