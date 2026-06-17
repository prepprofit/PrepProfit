import { auth } from '@clerk/nextjs/server';

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
 * Role for the ACTIVE organization, derived from the Clerk org-membership role
 * (`auth().orgRole`) — NOT user-global `publicMetadata`, which would leak manager
 * rights to EVERY org the user belongs to (RULE #1). Maps Clerk's built-in org
 * roles:
 *   - `org:admin`  → `manager` (financials, payroll, invoices, exports, trash)
 *   - everything else (incl. `org:member` / no active org) → `kitchen`
 * `kitchen` is the safe default (least privilege). Custom per-org roles are
 * deferred to Sprint 4 (billing); until then `org:admin` is the manager.
 */
export async function getUserRole(): Promise<UserRole> {
  const { orgRole } = await auth();
  return orgRole === 'org:admin' ? 'manager' : 'kitchen';
}

export async function isManager(): Promise<boolean> {
  return (await getUserRole()) === 'manager';
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
