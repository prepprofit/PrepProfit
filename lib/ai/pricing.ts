/**
 * AI extraction cost estimation (provider spend observability).
 *
 * The Gemini call's token usage (`input_tokens` / `output_tokens`) is recorded on
 * every `ai_extraction_attempts` row; this module turns that usage into an ESTIMATED
 * provider cost in micros of USD (millionths of a US dollar), stored in `cost_micros`.
 *
 * This is provider-spend metadata for the operator (how much the SaaS pays Google),
 * NOT tenant money — it is never shown as a customer charge and never stored as cents.
 * The figure is an ESTIMATE: tokens × the published per-token price. It can differ by
 * a fraction of a cent from Google's actual billing, and if Google changes prices the
 * table below must be updated.
 *
 * Pure + SDK-free, so the cost math is unit-tested against fixed inputs.
 */

/** Per-model price, expressed as micros of USD per 1,000,000 tokens (integer-friendly). */
type ModelPricing = {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
};

/**
 * Published Gemini pay-as-you-go prices (Standard tier), in USD per 1M tokens, mapped
 * to micros (1 USD = 1_000_000 micros):
 *
 *   gemini-2.5-flash — input $0.30/1M (text/image), output $2.50/1M (incl. thinking).
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing (confirmed 2026-06-28).
 * SWAP PATH: if Google changes prices or the pinned model
 * ({@link import('./recipe-extraction').RECIPE_EXTRACTION_MODEL}) changes, update this
 * table only and re-confirm the numbers against the pricing page.
 */
export const GEMINI_PRICING: Record<string, ModelPricing> = {
  'gemini-2.5-flash': {
    inputMicrosPerMillion: 300_000,
    outputMicrosPerMillion: 2_500_000,
  },
};

/** A finite, non-negative token count, or 0 for a null/absent count. */
function safeTokens(value: number | null | undefined): number | null {
  if (value == null) return 0;
  if (!Number.isFinite(value) || value < 0) return null; // garbage in ⇒ no estimate
  return value;
}

export type ComputeCostInput = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

/**
 * Estimated provider cost for one extraction call, in micros of USD, rounded to the
 * nearest micro. Returns `null` (never a fabricated cost) when:
 *   - the model has no price in {@link GEMINI_PRICING} (unknown / swapped model), or
 *   - a token count is present but not a finite, non-negative number, or
 *   - BOTH token counts are absent (the provider reported no usage at all).
 *
 * A single absent token count is treated as 0 (partial usage still yields an estimate).
 */
export function computeCostMicros(input: ComputeCostInput): number | null {
  const pricing = GEMINI_PRICING[input.model];
  if (!pricing) return null;

  // No usage reported at all ⇒ nothing to estimate.
  if (input.inputTokens == null && input.outputTokens == null) return null;

  const inTokens = safeTokens(input.inputTokens);
  const outTokens = safeTokens(input.outputTokens);
  if (inTokens === null || outTokens === null) return null;

  const micros =
    (inTokens * pricing.inputMicrosPerMillion +
      outTokens * pricing.outputMicrosPerMillion) /
    1_000_000;
  return Math.round(micros);
}

/**
 * Format a micros-of-USD figure as a human `$x.xxxx` string for the operator report.
 * Four decimals because a single extraction costs a fraction of a cent. `null`/invalid
 * renders as `—` so a missing estimate is never shown as `$0.0000`.
 */
export function formatCostMicrosUsd(costMicros: number | null | undefined): string {
  if (costMicros == null || !Number.isFinite(costMicros)) return '—';
  return `$${(costMicros / 1_000_000).toFixed(4)}`;
}
