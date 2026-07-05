import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_EXTRACTION_MONTHLY_LIMIT,
  PLAN_LIMITS,
  type Feature,
} from '@/lib/entitlements';

/**
 * Pre-launch audit (2026-07-02, finding F1) — the plan/price/feature story lives in
 * FOUR places that must never drift: the committed Clerk catalogue
 * (`clerk/billing.json`), the server-side entitlement constants
 * (`lib/entitlements.ts`), the public pricing copy (`lib/i18n/messages/en.json`),
 * and the CLAUDE.md "live mapping" prose. This test pins the machine-readable
 * three to each other so a future price/cap/feature change fails CI until every
 * surface is updated together.
 *
 * `clerk/billing.json` amounts are USD (Clerk charges in usd) and their NUMERIC
 * value matches the USD public pricing ($29/$79 ↔ 2900/7900).
 */

type BillingCatalogue = {
  billing: {
    organization_enabled: boolean;
    features: Record<string, unknown>;
    plans: Record<
      string,
      {
        amount: number;
        currency: string;
        features: string[];
        payer_type: string;
        free_trial_enabled?: boolean;
      }
    >;
  };
};

const catalogue = JSON.parse(
  readFileSync(join(process.cwd(), 'clerk', 'billing.json'), 'utf8'),
) as BillingCatalogue;

const messages = JSON.parse(
  readFileSync(join(process.cwd(), 'lib', 'i18n', 'messages', 'en.json'), 'utf8'),
) as {
  marketing: {
    pricing: {
      free: { price: string; f2: string; f4: string };
      solo: { price: string; priceYear: string; f1: string; f4: string };
      pro: { price: string; f1: string; f4: string };
      business: { price: string; f4: string };
    };
  };
};

/** Every Feature the app can gate on — keep in sync with the union in entitlements. */
const APP_FEATURES: Feature[] = ['invoices', 'break_even', 'payroll', 'advanced_documents'];

describe('billing catalogue ↔ entitlements ↔ public pricing consistency', () => {
  it('catalogue features exactly match the app Feature union (no ai_extraction flag)', () => {
    const catalogueFeatures = Object.keys(catalogue.billing.features).sort();
    expect(catalogueFeatures).toEqual([...APP_FEATURES].sort());
    // AI extraction is universal + quota-metered, never a Clerk feature.
    expect(catalogueFeatures).not.toContain('ai_extraction');
  });

  it('paid plans exist, are org-payer, and their feature sets nest (business ⊇ pro ⊇ solo)', () => {
    const { solo, pro, business } = catalogue.billing.plans;
    expect(solo).toBeDefined();
    expect(pro).toBeDefined();
    expect(business).toBeDefined();
    expect(solo!.payer_type).toBe('org');
    expect(pro!.payer_type).toBe('org');
    expect(business!.payer_type).toBe('org');
    // Solo ⊆ Pro ⊆ Business: each higher tier keeps every lower tier's features.
    expect(solo!.features).toEqual(['break_even']);
    for (const f of solo!.features) expect(pro!.features).toContain(f);
    expect(pro!.features).toEqual(['invoices', 'break_even']);
    for (const f of pro!.features) expect(business!.features).toContain(f);
    expect(business!.features).toEqual(
      expect.arrayContaining(['payroll', 'advanced_documents']),
    );
    // Every plan feature must be a defined catalogue feature the app knows.
    for (const plan of Object.values(catalogue.billing.plans)) {
      for (const f of plan.features) expect(APP_FEATURES).toContain(f as Feature);
    }
  });

  it('the reverse trial is the only trial — paid plans disable free_trial (Decision A)', () => {
    for (const plan of Object.values(catalogue.billing.plans)) {
      expect(plan.free_trial_enabled ?? false).toBe(false);
    }
  });

  it('catalogue amounts (usd) numerically match the USD pricing copy', () => {
    const { pricing } = messages.marketing;
    expect(catalogue.billing.plans.solo!.amount).toBe(1900);
    expect(catalogue.billing.plans.pro!.amount).toBe(2900);
    expect(catalogue.billing.plans.business!.amount).toBe(7900);
    expect(pricing.solo.price).toBe('$19');
    expect(pricing.pro.price).toBe('$29');
    expect(pricing.business.price).toBe('$79');
    expect(pricing.free.price).toBe('$0');
    // Yearly = 20% off: $19 × 12 × 0.8 = $182.40 → $180 (rounded to a clean price).
    expect(pricing.solo.priceYear).toBe('$180');
  });

  it('public copy matches the enforced caps (recipes, seats, AI quota)', () => {
    const { pricing } = messages.marketing;
    // Starter: 10 recipes, AI 10/mo.
    expect(PLAN_LIMITS.starter.recipes).toBe(10);
    expect(pricing.free.f2).toContain('10');
    expect(AI_EXTRACTION_MONTHLY_LIMIT.starter).toBe(10);
    expect(pricing.free.f4).toContain('10');
    // Solo: 1 seat, AI 40/mo.
    expect(PLAN_LIMITS.solo.seats).toBe(1);
    expect(pricing.solo.f1).toContain('1');
    expect(AI_EXTRACTION_MONTHLY_LIMIT.solo).toBe(40);
    expect(pricing.solo.f4).toContain('40');
    // Pro: 5 seats, AI 100/mo.
    expect(PLAN_LIMITS.pro.seats).toBe(5);
    expect(pricing.pro.f1).toContain('5');
    expect(AI_EXTRACTION_MONTHLY_LIMIT.pro).toBe(100);
    expect(pricing.pro.f4).toContain('100');
    // Business: unlimited seats, AI 500/mo.
    expect(PLAN_LIMITS.business.seats).toBe(Infinity);
    expect(AI_EXTRACTION_MONTHLY_LIMIT.business).toBe(500);
    expect(pricing.business.f4).toContain('500');
  });
});
