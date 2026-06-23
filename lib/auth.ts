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

/** A Clerk org member, for the task-assignee picker (display only — never stored). */
export type OrgMember = { userId: string; name: string };

/**
 * Active members of the current org, for the manager-only task-assignee picker
 * (Sprint 6 D2). Names are resolved for DISPLAY only and never persisted — the data
 * layer stores just the Clerk user id. Org seats are small (≤ a handful), so a single
 * page covers every member. Returns [] if there is no active org or the lookup fails
 * (the picker degrades gracefully; assignment still validates membership server-side).
 */
export async function listOrgMembers(): Promise<OrgMember[]> {
  const { orgId } = await auth();
  if (!orgId) return [];
  try {
    const client = await clerkClient();
    const { data } = await client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: 100,
    });
    return data
      .map((m) => {
        const u = m.publicUserData;
        if (!u?.userId) return null;
        const name =
          [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
          u.identifier ||
          u.userId;
        return { userId: u.userId, name };
      })
      .filter((m): m is OrgMember => m !== null);
  } catch {
    return [];
  }
}

/**
 * Whether `userId` is an ACTIVE member of the current org (Sprint 6 D2). Used by
 * `assignTaskAction` to validate an assignee BEFORE the mutation. Distinguishes a
 * definite non-member (returns false → `TASK_ASSIGNEE_INVALID`) from a transient
 * Clerk/API failure (THROWS → the action surfaces `unexpected`, never silently
 * accepts/rejects). The org id comes from the server (RULE #1).
 */
export async function isActiveOrgMember(userId: string): Promise<boolean> {
  const { orgId } = await auth();
  if (!orgId) return false;
  const client = await clerkClient();
  const { data } = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
    limit: 100,
  });
  return data.some((m) => m.publicUserData?.userId === userId);
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

/**
 * Pure role predicate — recipe/ingredient COST and PRICE (ingredient prices,
 * recipe cost breakdown, per-portion cost, selling price, margin, the cost sheet)
 * are financial and managers-only (Sprint F4). Kitchen sees the OPERATIONAL recipe
 * (names, quantities, units, yield, steps) but never money. Same shape as
 * {@link canAccessFinancials}; enforced server-side at the data, UI and write
 * layers (UI hiding alone is never enough — money is stripped from kitchen
 * payloads, and price/cost writes are refused for kitchen).
 */
export function canSeeRecipeCosts(role: UserRole): boolean {
  return role === 'manager';
}
