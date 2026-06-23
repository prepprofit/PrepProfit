import { beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable auth + db mocks so we can prove (a) the assignee membership gate runs
// BEFORE any data access, and (b) the kitchen-allowed task actions are NOT
// manager-gated (they reach the data layer instead of returning FORBIDDEN).
const { isManager, isActiveOrgMember, withOrg } = vi.hoisted(() => ({
  isManager: vi.fn(),
  isActiveOrgMember: vi.fn(),
  withOrg: vi.fn(async () => {
    throw new Error('REACHED_DATA');
  }),
}));

vi.mock('@/lib/auth', () => ({
  isManager,
  isActiveOrgMember,
  getOrgId: vi.fn(async () => 'org_a'),
  getUserId: vi.fn(async () => 'u1'),
  getUserRole: vi.fn(async () => 'manager'),
}));

vi.mock('@/lib/db', () => ({ withOrg }));

import {
  addTaskAction,
  assignTaskAction,
  createPrepTaskFromRecipeAction,
  toggleTaskAction,
} from '@/app/(app)/tasks/actions';

const ISO = '2026-01-01T00:00:00.000Z';

beforeEach(() => {
  isManager.mockReset();
  isActiveOrgMember.mockReset();
  withOrg.mockClear();
});

describe('task assignee membership validation (D2)', () => {
  it('rejects a non-member assignee with TASK_ASSIGNEE_INVALID before any data write', async () => {
    isManager.mockResolvedValue(true);
    isActiveOrgMember.mockResolvedValue(false);
    const result = await assignTaskAction('t1', {
      expectedUpdatedAt: ISO,
      assigneeUserId: 'ghost',
    });
    expect(result).toEqual({ ok: false, code: 'TASK_ASSIGNEE_INVALID' });
    expect(withOrg).not.toHaveBeenCalled();
  });

  it('refuses a kitchen user before validating membership', async () => {
    isManager.mockResolvedValue(false);
    const result = await assignTaskAction('t1', {
      expectedUpdatedAt: ISO,
      assigneeUserId: 'u2',
    });
    expect(result).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(isActiveOrgMember).not.toHaveBeenCalled();
  });
});

describe('kitchen-allowed task actions are NOT manager-gated (D1)', () => {
  it('add / toggle / prep reach the data layer for a kitchen user', async () => {
    isManager.mockResolvedValue(false); // kitchen
    // No isManager guard → they proceed to withOrg (our sentinel throw), proving
    // kitchen is not refused with FORBIDDEN.
    await expect(addTaskAction('l1', { title: 'x' })).rejects.toThrow('REACHED_DATA');
    await expect(
      toggleTaskAction('t1', { expectedUpdatedAt: ISO, done: true }),
    ).rejects.toThrow('REACHED_DATA');
    await expect(
      createPrepTaskFromRecipeAction({ listId: 'l1', recipeId: 'r1' }),
    ).rejects.toThrow('REACHED_DATA');
  });
});
