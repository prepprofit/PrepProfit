import { auth, currentUser } from '@clerk/nextjs/server';

export type UserRole = 'manager' | 'kitchen';

/**
 * REGRA Nº 1 (CLAUDE.md): o `organization_id` SEMPRE vem do servidor, via Clerk,
 * nunca do client. Lança erro se não houver organização ativa — o middleware
 * deve garantir que o usuário escolha/crie uma org antes de acessar /app.
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

/** Id do usuário autenticado (lança erro se não autenticado). */
export async function getUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated.');
  }
  return userId;
}

/**
 * Papel do usuário a partir do publicMetadata do Clerk.
 * Default seguro: 'kitchen' (menos privilégio).
 */
export async function getUserRole(): Promise<UserRole> {
  const user = await currentUser();
  const role = user?.publicMetadata?.role as UserRole | undefined;
  return role ?? 'kitchen';
}

export async function isManager(): Promise<boolean> {
  return (await getUserRole()) === 'manager';
}
