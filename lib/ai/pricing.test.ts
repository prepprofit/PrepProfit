import { describe, expect, it } from 'vitest';
import { computeCostMicros, formatCostMicrosUsd, GEMINI_PRICING } from '@/lib/ai/pricing';

const MODEL = 'gemini-2.5-flash';

describe('computeCostMicros', () => {
  it('prices input + output at the published per-million rates', () => {
    // 1M input ($0.30) + 1M output ($2.50) = $2.80 = 2_800_000 micros.
    expect(computeCostMicros({ model: MODEL, inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(
      2_800_000,
    );
  });

  it('prices a realistic single extraction (≈ a fraction of a cent)', () => {
    // 1500 input × 0.30 micros + 400 output × 2.50 micros = 450 + 1000 = 1450 micros ($0.00145).
    expect(computeCostMicros({ model: MODEL, inputTokens: 1500, outputTokens: 400 })).toBe(1450);
  });

  it('rounds to the nearest micro', () => {
    // 1 input token = 0.30 micros → rounds to 0; 5 = 1.5 → rounds to 2 (round-half-up).
    expect(computeCostMicros({ model: MODEL, inputTokens: 1, outputTokens: 0 })).toBe(0);
    expect(computeCostMicros({ model: MODEL, inputTokens: 5, outputTokens: 0 })).toBe(2);
  });

  it('treats a single absent token count as zero (partial usage still estimates)', () => {
    expect(computeCostMicros({ model: MODEL, inputTokens: 1_000_000, outputTokens: null })).toBe(
      300_000,
    );
    expect(computeCostMicros({ model: MODEL, inputTokens: null, outputTokens: 1_000_000 })).toBe(
      2_500_000,
    );
  });

  it('returns null when BOTH token counts are absent', () => {
    expect(computeCostMicros({ model: MODEL, inputTokens: null, outputTokens: null })).toBeNull();
  });

  it('returns null for an unknown / unpriced model (never fabricates a cost)', () => {
    expect(
      computeCostMicros({ model: 'gemini-3.5-flash', inputTokens: 1000, outputTokens: 1000 }),
    ).toBeNull();
  });

  it('returns null for non-finite or negative token counts (garbage in → no estimate)', () => {
    expect(computeCostMicros({ model: MODEL, inputTokens: NaN, outputTokens: 100 })).toBeNull();
    expect(computeCostMicros({ model: MODEL, inputTokens: Infinity, outputTokens: 100 })).toBeNull();
    expect(computeCostMicros({ model: MODEL, inputTokens: -5, outputTokens: 100 })).toBeNull();
  });

  it('handles zero usage as a zero cost (not null) when usage was reported', () => {
    expect(computeCostMicros({ model: MODEL, inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('handles large token counts without overflow into a float mess', () => {
    // 50M input + 10M output = 15_000_000 + 25_000_000 = 40_000_000 micros ($40).
    expect(
      computeCostMicros({ model: MODEL, inputTokens: 50_000_000, outputTokens: 10_000_000 }),
    ).toBe(40_000_000);
  });

  it('keeps the pinned model priced (guards against a silent pricing-table drop)', () => {
    expect(GEMINI_PRICING[MODEL]).toBeDefined();
  });
});

describe('formatCostMicrosUsd', () => {
  it('formats micros as a 4-decimal USD string', () => {
    expect(formatCostMicrosUsd(12_345)).toBe('$0.0123');
    expect(formatCostMicrosUsd(2_800_000)).toBe('$2.8000');
    expect(formatCostMicrosUsd(0)).toBe('$0.0000');
  });

  it('renders a missing/invalid estimate as an em dash, not $0', () => {
    expect(formatCostMicrosUsd(null)).toBe('—');
    expect(formatCostMicrosUsd(undefined)).toBe('—');
    expect(formatCostMicrosUsd(NaN)).toBe('—');
  });
});
