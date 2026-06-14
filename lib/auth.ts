import { auth, currentUser } from '@clerk/nextjs/server';

export type UserRole = 'manager' | 'kitchen';

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
 * User role from Clerk publicMetadata.
 * Safe default: 'kitchen' (least privilege).
 */
export async function getUserRole(): Promise<UserRole> {
  const user = await currentUser();
  const role = user?.publicMetadata?.role as UserRole | undefined;
  return role ?? 'kitchen';
}

export async function isManager(): Promise<boolean> {
  return (await getUserRole()) === 'manager';
}
