import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sprint 4e — org self-delete lockdown. Drives `ensureOrgLockdown` against a
 * mocked Clerk Backend API + a mocked `serverEnv`. Proves: the system user is
 * reserved as `org:admin` (created if absent / promoted if present), every human
 * admin is demoted to `org:owner`, the system user is never demoted, the run is
 * idempotent, it no-ops when the env is unset, and the system admin is ensured
 * BEFORE any human admin is demoted (so the org never loses its last admin).
 */
const SYSTEM_ID = 'user_system';
const ORG = 'org_test';

const h = vi.hoisted(() => ({
  systemId: undefined as string | undefined,
  memberships: [] as Array<{ publicUserData?: { userId?: string }; role: string }>,
  calls: [] as string[],
}));

const createMembership = vi.fn(async (args: { userId: string; role: string }) => {
  h.calls.push(`create:${args.userId}:${args.role}`);
});
const updateMembership = vi.fn(async (args: { userId: string; role: string }) => {
  h.calls.push(`update:${args.userId}:${args.role}`);
});
const listMemberships = vi.fn(async () => {
  h.calls.push('list');
  return { data: h.memberships, totalCount: h.memberships.length };
});

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({
    organizations: {
      getOrganizationMembershipList: listMemberships,
      createOrganizationMembership: createMembership,
      updateOrganizationMembership: updateMembership,
    },
  }),
}));

vi.mock('@/lib/env', () => ({
  serverEnv: () => ({ CLERK_SYSTEM_USER_ID: h.systemId }),
}));

const logError = vi.fn();
vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => logError(...args),
}));

import { ensureOrgLockdown } from '@/lib/org/lockdown';

beforeEach(() => {
  h.systemId = SYSTEM_ID;
  h.memberships = [];
  h.calls = [];
  createMembership.mockClear();
  updateMembership.mockClear();
  listMemberships.mockClear();
  logError.mockClear();
});

describe('ensureOrgLockdown', () => {
  it('adds the system admin and demotes the human creator to org:owner', async () => {
    h.memberships = [{ publicUserData: { userId: 'user_creator' }, role: 'org:admin' }];

    await ensureOrgLockdown(ORG);

    expect(createMembership).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: SYSTEM_ID,
      role: 'org:admin',
    });
    expect(updateMembership).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: 'user_creator',
      role: 'org:owner',
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it('promotes the system user when present but not admin', async () => {
    h.memberships = [
      { publicUserData: { userId: SYSTEM_ID }, role: 'org:member' },
      { publicUserData: { userId: 'user_creator' }, role: 'org:admin' },
    ];

    await ensureOrgLockdown(ORG);

    expect(createMembership).not.toHaveBeenCalled();
    expect(updateMembership).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: SYSTEM_ID,
      role: 'org:admin',
    });
    expect(updateMembership).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: 'user_creator',
      role: 'org:owner',
    });
  });

  it('ensures the system admin BEFORE demoting any human admin', async () => {
    h.memberships = [{ publicUserData: { userId: 'user_creator' }, role: 'org:admin' }];

    await ensureOrgLockdown(ORG);

    const ensureIdx = h.calls.indexOf(`create:${SYSTEM_ID}:org:admin`);
    const demoteIdx = h.calls.indexOf('update:user_creator:org:owner');
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(demoteIdx).toBeGreaterThan(ensureIdx);
  });

  it('is idempotent: a locked-down org needs no writes', async () => {
    h.memberships = [
      { publicUserData: { userId: SYSTEM_ID }, role: 'org:admin' },
      { publicUserData: { userId: 'user_creator' }, role: 'org:owner' },
    ];

    await ensureOrgLockdown(ORG);

    expect(createMembership).not.toHaveBeenCalled();
    expect(updateMembership).not.toHaveBeenCalled();
  });

  it('never demotes the system user even if it is the only admin', async () => {
    h.memberships = [{ publicUserData: { userId: SYSTEM_ID }, role: 'org:admin' }];

    await ensureOrgLockdown(ORG);

    expect(createMembership).not.toHaveBeenCalled();
    expect(updateMembership).not.toHaveBeenCalled();
  });

  it('no-ops (logs, no API calls) when CLERK_SYSTEM_USER_ID is unset', async () => {
    h.systemId = undefined;

    await ensureOrgLockdown(ORG);

    expect(listMemberships).not.toHaveBeenCalled();
    expect(createMembership).not.toHaveBeenCalled();
    expect(updateMembership).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('swallows Clerk API errors (never throws into the hot path)', async () => {
    h.memberships = [{ publicUserData: { userId: 'user_creator' }, role: 'org:admin' }];
    listMemberships.mockRejectedValueOnce(new Error('clerk down'));

    await expect(ensureOrgLockdown(ORG)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
