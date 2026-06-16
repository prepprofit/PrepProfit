import { describe, expect, it, vi } from 'vitest';

// A kitchen-role user: isManager() resolves false. getOrgId is stubbed but should
// never be reached — the guard must return FORBIDDEN before any data access.
vi.mock('@/lib/auth', () => ({
  isManager: vi.fn().mockResolvedValue(false),
  getOrgId: vi.fn(async () => {
    throw new Error('getOrgId must not be called for a forbidden request');
  }),
}));

import {
  createTransactionAction,
  updateTransactionAction,
  deleteTransactionAction,
  createCategoryAction,
  renameCategoryAction,
  deleteCategoryAction,
} from '@/app/(app)/transactions/actions';

describe('financial actions are manager-only', () => {
  it('rejects a kitchen-role user with FORBIDDEN before touching data', async () => {
    const results = await Promise.all([
      createTransactionAction({}),
      updateTransactionAction('t1', {}),
      deleteTransactionAction('t1'),
      createCategoryAction({}),
      renameCategoryAction('c1', {}),
      deleteCategoryAction('c1'),
    ]);

    for (const result of results) {
      expect(result).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
  });
});
