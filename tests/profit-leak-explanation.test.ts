import { describe, expect, it } from 'vitest';
import {
  parseProfitLeakExplanationResponse,
  profitLeakExplanationSchema,
  ProfitLeakExplanationError,
} from '@/lib/ai/profit-leak-explanation';

/**
 * Pure tests for the profit-leak explanation provider boundary (Sprint 4): the
 * untrusted-input Zod schema and the parse function. No network / provider involved.
 */

function validExplanation() {
  return {
    headline: 'Cheesecake Slice is below your 65% margin target',
    explanation:
      'This item currently returns less profit than your target. Review the selling ' +
      'price or the recipe cost to bring it back in line.',
    actionLabel: 'Review selling price',
    riskLevel: 'medium' as const,
  };
}

describe('profitLeakExplanationSchema (untrusted boundary)', () => {
  it('accepts a well-formed explanation', () => {
    expect(profitLeakExplanationSchema.safeParse(validExplanation()).success).toBe(true);
  });

  it('rejects an invalid riskLevel', () => {
    const bad = { ...validExplanation(), riskLevel: 'catastrophic' };
    expect(profitLeakExplanationSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty headline', () => {
    const bad = { ...validExplanation(), headline: '' };
    expect(profitLeakExplanationSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an over-length explanation (memory/UI guard)', () => {
    const bad = { ...validExplanation(), explanation: 'x'.repeat(601) };
    expect(profitLeakExplanationSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const bad = validExplanation() as Record<string, unknown>;
    delete bad.actionLabel;
    expect(profitLeakExplanationSchema.safeParse(bad).success).toBe(false);
  });
});

describe('parseProfitLeakExplanationResponse', () => {
  it('parses valid JSON', () => {
    const out = parseProfitLeakExplanationResponse(JSON.stringify(validExplanation()));
    expect(out.riskLevel).toBe('medium');
    expect(out.actionLabel).toBe('Review selling price');
  });

  it('throws on non-JSON', () => {
    expect(() => parseProfitLeakExplanationResponse('not json')).toThrow(
      ProfitLeakExplanationError,
    );
  });

  it('throws on schema violation', () => {
    expect(() => parseProfitLeakExplanationResponse('{"headline":"x"}')).toThrow(
      ProfitLeakExplanationError,
    );
  });
});
