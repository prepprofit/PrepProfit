import { describe, expect, it } from 'vitest';
import { canAccessFinancials, USER_ROLES } from './auth';

describe('canAccessFinancials', () => {
  it('grants access to managers only', () => {
    expect(canAccessFinancials('manager')).toBe(true);
    expect(canAccessFinancials('kitchen')).toBe(false);
  });

  it('manager is the only role that may reach financials', () => {
    expect(USER_ROLES.filter(canAccessFinancials)).toEqual(['manager']);
  });
});
