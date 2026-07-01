import {
  GoogleGenAI,
  ApiError,
  Type,
  type Schema,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import { z } from 'zod';
import { aiEnv } from '@/lib/env';
import type { DailyCloseInsights } from '@/lib/calculations/daily-close-insights';

/**
 * Daily Close Summary AI provider seam (Sprint 6, AI margin roadmap).
 *
 * Mirrors `lib/ai/profit-leak-explanation.ts`: the app talks to the model through the
 * small {@link DailyCloseSummarizer} interface, never the SDK directly, so tests inject a
 * fake (no network/key) and the model id lives in ONE constant. CLAUDE.md "AI and import
 * rules": model output is UNTRUSTED — validated with {@link dailyCloseSummarySchema} before
 * it leaves this module. The Sprint-6 rule (plan §11): the model is only SUMMARIZING
 * numbers PrepProfit already computed deterministically ({@link DailyCloseInsights}). It
 * receives compact {@link DailyCloseSummaryFacts} (no DB rows) and returns prose + a risk
 * label; it must NEVER calculate food cost or invent a figure. The API key is read lazily
 * via `aiEnv()` inside `summarize()` and is NEVER logged.
 */

/* -------------------------------------------------------------------------- */
/* Model config (the ONE place the provider/model id is pinned).              */
/* -------------------------------------------------------------------------- */

/**
 * The pinned summary model. **Gemini 2.5 Flash (Stable)**: the same cheap, mature model
 * the invoice/explanation paths settled on. Text-only here (facts in, prose out). SWAP
 * PATH: change this constant only (re-confirm the id at deploy time). Kept in
 * {@link import('./pricing').GEMINI_PRICING} for cost estimation.
 */
export const DAILY_CLOSE_SUMMARY_MODEL = 'gemini-2.5-flash';

/** The provider/vendor label recorded on each `ai_operation_attempts` row. */
export const DAILY_CLOSE_SUMMARY_PROVIDER = 'google';

/* -------------------------------------------------------------------------- */
/* Strict result schema — the untrusted-input boundary.                       */
/* -------------------------------------------------------------------------- */

const MAX_HEADLINE_LEN = 120;
const MAX_SUMMARY_LEN = 700;
const MAX_HIGHLIGHT_LEN = 160;
const MAX_HIGHLIGHTS = 4;

/**
 * The validated AI summary (plan §11 output). Bounded string lengths + a capped highlight
 * list so a hallucinated/garbage response can never balloon memory or the UI card.
 * `riskLevel` is the model's qualitative read of the day, NOT a money figure.
 */
export const dailyCloseSummarySchema = z.object({
  headline: z.string().trim().min(1).max(MAX_HEADLINE_LEN),
  summary: z.string().trim().min(1).max(MAX_SUMMARY_LEN),
  highlights: z
    .array(z.string().trim().min(1).max(MAX_HIGHLIGHT_LEN))
    .max(MAX_HIGHLIGHTS)
    .default([]),
  riskLevel: z.enum(['low', 'medium', 'high']),
});
export type DailyCloseSummary = z.infer<typeof dailyCloseSummarySchema>;

/**
 * The Gemini structured-output (`responseSchema`) mirror of the Zod schema. Kept adjacent
 * so the two never drift: the model is asked to return EXACTLY this shape, and the parsed
 * result is still re-validated by Zod (defence in depth).
 */
const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    headline: { type: Type.STRING },
    summary: { type: Type.STRING },
    highlights: { type: Type.ARRAY, items: { type: Type.STRING } },
    riskLevel: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
  },
  required: ['headline', 'summary', 'riskLevel'],
};

/**
 * Thrown when the model returns non-JSON, fails validation, or the provider call fails.
 * `retryable` is true when the underlying failure was a TRANSIENT provider
 * overload/rate-limit (a 429/5xx that survived our retries) rather than a bad response.
 */
export class DailyCloseSummaryError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'DailyCloseSummaryError';
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Parse + validate a raw model response into a strict {@link DailyCloseSummary}. The
 * untrusted-input boundary: invalid JSON or any schema violation throws
 * {@link DailyCloseSummaryError} (key-free message) and never yields partial data. Pure
 * and SDK-free, so it is unit-tested against fixed fixtures without any network.
 */
export function parseDailyCloseSummaryResponse(rawText: string): DailyCloseSummary {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new DailyCloseSummaryError('Model returned non-JSON output.');
  }
  const parsed = dailyCloseSummarySchema.safeParse(json);
  if (!parsed.success) {
    throw new DailyCloseSummaryError('Model output failed schema validation.');
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Facts — the compact, structured input the model receives (pure, SDK-free). */
/* -------------------------------------------------------------------------- */

/**
 * The exact payload sent to the model. Deliberately compact: descriptors + the figures
 * PrepProfit ALREADY computed (so it is exactly what the manager sees), never DB records.
 * Money is integer cents + a currency code so the model can present amounts without doing
 * arithmetic. Nothing here is derived by the model.
 */
export type DailyCloseSummaryFacts = {
  saleDate: string;
  currency: string;
  grossSalesCents: number;
  netSalesCents: number;
  estimatedFoodCostCents: number | null;
  foodCostPercent: number | null;
  /** False when some sold items had no cost, so food cost is a PARTIAL figure. */
  costComplete: boolean;
  targetMarginPercent: number;
  itemCount: number;
  unitsSold: number;
  topSellers: { name: string; unitsSold: number }[];
  lowMarginSellers: { name: string; marginPercent: number }[];
  /** Names of sold items with no resolvable cost (so the summary can note the gap). */
  missingCostItemNames: string[];
  variance:
    | { changePercent: number; direction: 'up' | 'down' | 'flat'; sampleSize: number; unusual: boolean }
    | null;
};

/** Cap the list sizes sent to the model — the tail adds tokens, not signal. */
const MAX_FACT_SELLERS = 5;

/**
 * Distil the deterministic insights into the model's fact input (pure). Every figure comes
 * straight off {@link DailyCloseInsights}; this never derives or fabricates a number. The
 * caller passes the org currency for presentation only.
 */
export function buildDailyCloseSummaryFacts(
  insights: DailyCloseInsights,
  currency: string,
): DailyCloseSummaryFacts {
  return {
    saleDate: insights.saleDate,
    currency,
    grossSalesCents: insights.grossSalesCents,
    netSalesCents: insights.netSalesCents,
    estimatedFoodCostCents: insights.estimatedFoodCostCents,
    foodCostPercent: insights.foodCostPercent,
    costComplete: insights.costComplete,
    targetMarginPercent: insights.targetMarginPercent,
    itemCount: insights.itemCount,
    unitsSold: insights.unitsSold,
    topSellers: insights.topSellers
      .slice(0, MAX_FACT_SELLERS)
      .map((s) => ({ name: s.name, unitsSold: s.unitsSold })),
    lowMarginSellers: insights.lowMarginSellers
      .slice(0, MAX_FACT_SELLERS)
      .map((s) => ({ name: s.name, marginPercent: s.marginPercent })),
    missingCostItemNames: insights.missingCostItems.map((m) => m.name),
    variance: insights.variance
      ? {
          changePercent: insights.variance.changePercent,
          direction: insights.variance.direction,
          sampleSize: insights.variance.sampleSize,
          unusual: insights.variance.unusual,
        }
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Transient-failure retry (identical policy to the other AI paths).          */
/* -------------------------------------------------------------------------- */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isTransientProviderError(err: unknown): boolean {
  return err instanceof ApiError && RETRYABLE_STATUS.has(err.status);
}

async function generateContentWithRetry(
  ai: GoogleGenAI,
  request: GenerateContentParameters,
): Promise<{ response: GenerateContentResponse; attempts: number }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent(request);
      return { response, attempts: attempt };
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isTransientProviderError(err)) throw err;
      const window = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(Math.random() * window);
    }
  }
  throw new DailyCloseSummaryError('Summary exhausted all retries.');
}

/* -------------------------------------------------------------------------- */
/* Provider seam.                                                             */
/* -------------------------------------------------------------------------- */

export type DailyCloseSummaryUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type SummarizeDailyCloseResult = {
  summary: DailyCloseSummary;
  usage: DailyCloseSummaryUsage;
  model: string;
  provider: string;
  /** How many provider calls this took (1 = first-try; >1 = a transient overload retried). */
  attempts?: number;
};

export interface DailyCloseSummarizer {
  summarize(facts: DailyCloseSummaryFacts): Promise<SummarizeDailyCloseResult>;
}

/** The summary instruction. Optimized for practical, honest, number-safe prose. */
const SUMMARY_PROMPT = [
  'You are a friendly restaurant analyst helping a busy manager review the day they',
  'just closed. PrepProfit has already computed every number for you.',
  'Your ONLY job is to SUMMARIZE these facts in plain, practical language. Return ONLY',
  'JSON matching the schema.',
  'Absolute rules:',
  '- NEVER calculate, estimate, or invent any number. Use only the figures in the facts.',
  '  If a figure is null, do not mention or guess it.',
  '- Present money amounts in the given currency exactly as provided; do not re-derive them.',
  '- If costComplete is false, say the food cost is PARTIAL because some items are not yet',
  '  priced; name a few from missingCostItemNames. Never imply the food cost is final.',
  '- headline: one short sentence capturing the day (e.g. sales up, or a food-cost concern).',
  '- summary: 2-4 short sentences on sales, food cost/margin, and any standout item.',
  '- highlights: up to 4 short bullet strings for the most useful specifics (top seller,',
  '  a thin-margin item, an unusual swing vs comparable days). Omit if nothing stands out.',
  '- riskLevel: low, medium, or high — your qualitative read of how much this day needs',
  '  attention (high food cost %, thin margins, or an unusual drop push it up).',
  '- Be encouraging and concrete, never alarmist.',
].join('\n');

/**
 * Build the production Gemini-backed summarizer. Lazy: `aiEnv()` and the client
 * construction run on the first `summarize`, not at module load, keeping `next build`/CI
 * green without secrets. THROWS {@link DailyCloseSummaryError} on any provider/parse
 * failure. The key is never logged.
 */
export function getDailyCloseSummarizer(): DailyCloseSummarizer {
  return {
    async summarize(facts: DailyCloseSummaryFacts): Promise<SummarizeDailyCloseResult> {
      const { apiKey } = aiEnv();
      const ai = new GoogleGenAI({ apiKey });

      let response;
      let attempts: number;
      try {
        ({ response, attempts } = await generateContentWithRetry(ai, {
          model: DAILY_CLOSE_SUMMARY_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                { text: SUMMARY_PROMPT },
                { text: `Facts:\n${JSON.stringify(facts)}` },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema,
            temperature: 0.2,
          },
        }));
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        throw new DailyCloseSummaryError(`Daily-close summary request failed: ${reason}`, {
          retryable: isTransientProviderError(err),
        });
      }

      const text = response.text;
      if (!text) {
        throw new DailyCloseSummaryError('Model returned an empty response.');
      }

      const summary = parseDailyCloseSummaryResponse(text);
      const usage = response.usageMetadata;
      return {
        summary,
        usage: {
          inputTokens: usage?.promptTokenCount ?? null,
          outputTokens: usage?.candidatesTokenCount ?? null,
        },
        model: DAILY_CLOSE_SUMMARY_MODEL,
        provider: DAILY_CLOSE_SUMMARY_PROVIDER,
        attempts,
      };
    },
  };
}
