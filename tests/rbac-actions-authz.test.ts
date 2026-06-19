import { describe, expect, it, vi } from 'vitest';

// A kitchen-role user: isManager() resolves false. getOrgId is stubbed to throw
// so the test ALSO proves the guard returns FORBIDDEN *before* any data access.
vi.mock('@/lib/auth', () => ({
  isManager: vi.fn().mockResolvedValue(false),
  getOrgId: vi.fn(async () => {
    throw new Error('getOrgId must not be called for a forbidden request');
  }),
}));

import {
  issueInvoiceAction,
  markInvoicePaidAction,
  voidInvoiceAction,
  deleteInvoiceAction,
} from '@/app/(app)/invoices/actions';
import {
  createShiftAction,
  updateShiftAction,
  closeShiftAction,
  deleteShiftAction,
} from '@/app/(app)/payroll/actions';
import {
  restoreRecipeAction,
  restoreIngredientAction,
  purgeRecipeAction,
  purgeIngredientAction,
  restoreTransactionAction,
  purgeTransactionAction,
  restoreCustomerAction,
  purgeCustomerAction,
  restoreInvoiceAction,
  purgeInvoiceAction,
} from '@/app/(app)/trash/actions';
import { updateOrgSettingsAction } from '@/app/(app)/settings/actions';
import { completeOnboardingAction } from '@/app/(app)/onboarding/actions';

const FORBIDDEN = { ok: false, code: 'FORBIDDEN' };

describe('manager-only actions reject kitchen before touching data', () => {
  it('blocks invoice actions', async () => {
    const results = await Promise.all([
      issueInvoiceAction('i1', {}),
      markInvoicePaidAction('i1'),
      voidInvoiceAction('i1'),
      deleteInvoiceAction('i1'),
    ]);
    for (const result of results) expect(result).toEqual(FORBIDDEN);
  });

  it('blocks payroll (shift) actions', async () => {
    const results = await Promise.all([
      createShiftAction({}),
      updateShiftAction('s1', {}),
      closeShiftAction('s1', {}),
      deleteShiftAction('s1'),
    ]);
    for (const result of results) expect(result).toEqual(FORBIDDEN);
  });

  it('blocks ALL trash actions (the trash is manager-only)', async () => {
    const results = await Promise.all([
      restoreRecipeAction('r1'),
      restoreIngredientAction('ing1'),
      purgeRecipeAction('r1'),
      purgeIngredientAction('ing1'),
      restoreTransactionAction('t1'),
      purgeTransactionAction('t1'),
      restoreCustomerAction('c1'),
      purgeCustomerAction('c1'),
      restoreInvoiceAction('i1'),
      purgeInvoiceAction('i1'),
    ]);
    for (const result of results) expect(result).toEqual(FORBIDDEN);
  });

  it('blocks settings update (org-wide config is manager-only)', async () => {
    // The guard must short-circuit BEFORE getOrgId (mocked to throw), so a
    // FORBIDDEN result proves kitchen was refused without touching data.
    const result = await updateOrgSettingsAction(null, new FormData());
    expect(result).toEqual(FORBIDDEN);
  });

  it('blocks completing onboarding (manager-only, refused before data)', async () => {
    // getOrgId is mocked to throw, so FORBIDDEN proves the guard short-circuits
    // before markOnboarded / the audit write.
    const result = await completeOnboardingAction();
    expect(result).toEqual(FORBIDDEN);
  });
});
