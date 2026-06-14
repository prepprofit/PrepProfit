import { auth, currentUser } from '@clerk/nextjs/server';

export const USER_ROLES = ['manager', 'kitchen'] as const;
export type UserRole = (typeof USER_ROLES)[number];

function isUserRole(value: unknown): value is UserRole {
  return (
    typeof value === 'string' &&
    (USER_ROLES as readonly string[]).includes(value)
  );
}

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
 * User role from Clerk publicMetadata, validated against the known set — never
 * trust raw metadata. Safe default: 'kitchen' (least privilege) for missing or
 * unexpected values.
 */
export async function getUserRole(): Promise<UserRole> {
  const user = await currentUser();
  const role = user?.publicMetadata?.role;
  return isUserRole(role) ? role : 'kitchen';
}

export async function isManager(): Promise<boolean> {
  return (await getUserRole()) === 'manager';
}
