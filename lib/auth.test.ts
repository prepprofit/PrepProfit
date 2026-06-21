import { describe, expect, it } from 'vitest';
import { canAccessFinancials, canSeeRecipeCosts, USER_ROLES } from './auth';

describe('canAccessFinancials', () => {
  it('grants access to managers only', () => {
    expect(canAccessFinancials('manager')).toBe(true);
    expect(canAccessFinancials('kitchen')).toBe(false);
  });

  it('manager is the only role that may reach financials', () => {
    expect(USER_ROLES.filter(canAccessFinancials)).toEqual(['manager']);
  });
});

describe('canSeeRecipeCosts (Sprint F4)', () => {
  it('grants recipe/ingredient cost + price visibility to managers only', () => {
    expect(canSeeRecipeCosts('manager')).toBe(true);
    expect(canSeeRecipeCosts('kitchen')).toBe(false);
  });

  it('manager is the only role that may see recipe money', () => {
    expect(USER_ROLES.filter(canSeeRecipeCosts)).toEqual(['manager']);
  });
});
