import { beforeEach, describe, expect, it, vi } from 'vitest';

// getUserRole() must read the ACTIVE org membership role, never a user-global
// field — so we mock Clerk's auth() and drive `orgRole` per call.
const authMock = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => authMock(),
}));

import { getUserRole, isManager } from '@/lib/auth';

beforeEach(() => {
  authMock.mockReset();
});

describe('getUserRole — scoped to the active organization', () => {
  it('maps org:admin to manager', async () => {
    authMock.mockResolvedValue({ orgRole: 'org:admin' });
    expect(await getUserRole()).toBe('manager');
    expect(await isManager()).toBe(true);
  });

  it('maps the custom org:owner role to manager (Sprint 4e lockdown)', async () => {
    authMock.mockResolvedValue({ orgRole: 'org:owner' });
    expect(await getUserRole()).toBe('manager');
    expect(await isManager()).toBe(true);
  });

  it('maps org:member to kitchen (least privilege)', async () => {
    authMock.mockResolvedValue({ orgRole: 'org:member' });
    expect(await getUserRole()).toBe('kitchen');
    expect(await isManager()).toBe(false);
  });

  it('defaults to kitchen when there is no active org role', async () => {
    authMock.mockResolvedValue({ orgRole: undefined });
    expect(await getUserRole()).toBe('kitchen');
  });

  it('the SAME user is manager in one org and kitchen in another', async () => {
    // Org A active: admin → manager.
    authMock.mockResolvedValueOnce({ orgRole: 'org:admin' });
    expect(await getUserRole()).toBe('manager');

    // Switch active org to B where they are only a member → kitchen.
    authMock.mockResolvedValueOnce({ orgRole: 'org:member' });
    expect(await getUserRole()).toBe('kitchen');
  });
});
