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
import type { Dimension } from '@/lib/units';
import {
  displayCanonical,
  type PrepReorderPlan,
} from '@/lib/calculations/prep-reorder-plan';

/**
 * Prep/Reorder Plan Summary AI provider seam (Sprint 7, AI margin roadmap).
 *
 * Mirrors `lib/ai/daily-close-summary.ts`: the app talks to the model through the small
 * {@link PrepPlanSummarizer} interface, never the SDK directly, so tests inject a fake (no
 * network/key) and the model id lives in ONE constant. CLAUDE.md "AI and import rules":
 * model output is UNTRUSTED — validated with {@link prepPlanSummarySchema} before it leaves
 * this module. The Sprint-7 rule (plan §12): the model may only FORMAT the plan PrepProfit
 * already computed deterministically ({@link PrepReorderPlan}); it receives compact,
 * MONEY-FREE {@link PrepPlanSummaryFacts} (no DB rows, no prices) and must NEVER invent an
 * ingredient quantity. The API key is read lazily via `aiEnv()` inside `summarize()` and is
 * NEVER logged.
 */

/* -------------------------------------------------------------------------- */
/* Model config (the ONE place the provider/model id is pinned).              */
/* -------------------------------------------------------------------------- */

/** The pinned summary model — the same cheap, mature text model the other AI paths use. */
export const PREP_PLAN_SUMMARY_MODEL = 'gemini-2.5-flash';
/** The provider/vendor label recorded on each `ai_operation_attempts` row. */
export const PREP_PLAN_SUMMARY_PROVIDER = 'google';

/* -------------------------------------------------------------------------- */
/* Strict result schema — the untrusted-input boundary.                       */
/* -------------------------------------------------------------------------- */

const MAX_HEADLINE_LEN = 120;
const MAX_SUMMARY_LEN = 700;
const MAX_HIGHLIGHT_LEN = 160;
const MAX_HIGHLIGHTS = 4;

/**
 * The validated AI summary (plan §12 output). Bounded string lengths + a capped highlight
 * list so a hallucinated/garbage response can never balloon memory or the UI card.
 * `supplyRisk` is the model's qualitative read of how exposed the plan is (shortfalls,
 * low-stock, data gaps) — NOT a quantity it computed.
 */
export const prepPlanSummarySchema = z.object({
  headline: z.string().trim().min(1).max(MAX_HEADLINE_LEN),
  summary: z.string().trim().min(1).max(MAX_SUMMARY_LEN),
  highlights: z
    .array(z.string().trim().min(1).max(MAX_HIGHLIGHT_LEN))
    .max(MAX_HIGHLIGHTS)
    .default([]),
  supplyRisk: z.enum(['low', 'medium', 'high']),
});
export type PrepPlanSummary = z.infer<typeof prepPlanSummarySchema>;

/** The Gemini structured-output mirror of the Zod schema (kept adjacent so they can't drift). */
const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    headline: { type: Type.STRING },
    summary: { type: Type.STRING },
    highlights: { type: Type.ARRAY, items: { type: Type.STRING } },
    supplyRisk: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
  },
  required: ['headline', 'summary', 'supplyRisk'],
};

/**
 * Thrown when the model returns non-JSON, fails validation, or the provider call fails.
 * `retryable` is true when the underlying failure was a TRANSIENT provider
 * overload/rate-limit (a 429/5xx that survived our retries) rather than a bad response.
 */
export class PrepPlanSummaryError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'PrepPlanSummaryError';
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Parse + validate a raw model response into a strict {@link PrepPlanSummary}. The
 * untrusted-input boundary: invalid JSON or any schema violation throws
 * {@link PrepPlanSummaryError} (key-free message) and never yields partial data. Pure and
 * SDK-free, so it is unit-tested against fixed fixtures without any network.
 */
export function parsePrepPlanSummaryResponse(rawText: string): PrepPlanSummary {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new PrepPlanSummaryError('Model returned non-JSON output.');
  }
  const parsed = prepPlanSummarySchema.safeParse(json);
  if (!parsed.success) {
    throw new PrepPlanSummaryError('Model output failed schema validation.');
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Facts — the compact, MONEY-FREE input the model receives (pure, SDK-free).  */
/* -------------------------------------------------------------------------- */

/**
 * The exact payload sent to the model. Deliberately compact: descriptors + the whole-unit
 * quantities PrepProfit ALREADY computed (grams / millilitres / count via `dimension`),
 * never DB records and NEVER a price. Nothing here is derived by the model.
 */
export type PrepPlanSummaryFacts = {
  recipeCount: number;
  prep: { name: string; portions: number; batches: number }[];
  reorder: { name: string; dimension: Dimension; shortfall: number }[];
  lowStock: {
    name: string;
    dimension: Dimension;
    onHand: number;
    threshold: number;
    projected: number;
  }[];
  /** Counts of surfaced data gaps so the model can nudge the manager to fix them. */
  issues: { missingYield: number; missingLines: number; deletedIngredient: number };
};

/** Cap the list sizes sent to the model — the tail adds tokens, not signal. */
const MAX_FACT_ITEMS = 12;

/**
 * Distil the deterministic plan into the model's fact input (pure, MONEY-FREE). Every figure
 * comes straight off {@link PrepReorderPlan} (rounded to whole canonical units for display);
 * this never derives or fabricates a number.
 */
export function buildPrepPlanSummaryFacts(
  plan: PrepReorderPlan,
): PrepPlanSummaryFacts {
  return {
    recipeCount: plan.prepSuggestions.length,
    prep: plan.prepSuggestions.slice(0, MAX_FACT_ITEMS).map((p) => ({
      name: p.recipeName,
      portions: p.expectedPortions,
      batches: p.batches,
    })),
    reorder: plan.reorderSuggestions.slice(0, MAX_FACT_ITEMS).map((r) => ({
      name: r.ingredientName,
      dimension: r.dimension,
      shortfall: displayCanonical(r.shortfallCanonical),
    })),
    lowStock: plan.lowStockWarnings.slice(0, MAX_FACT_ITEMS).map((w) => ({
      name: w.ingredientName,
      dimension: w.dimension,
      onHand: displayCanonical(w.onHandCanonical),
      threshold: displayCanonical(w.thresholdCanonical),
      projected: displayCanonical(w.projectedOnHandCanonical),
    })),
    issues: {
      missingYield: plan.issues.filter((i) => i.code === 'MISSING_YIELD').length,
      missingLines: plan.issues.filter((i) => i.code === 'MISSING_LINES').length,
      deletedIngredient: plan.issues.filter((i) => i.code === 'DELETED_INGREDIENT')
        .length,
    },
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
  throw new PrepPlanSummaryError('Summary exhausted all retries.');
}

/* -------------------------------------------------------------------------- */
/* Provider seam.                                                             */
/* -------------------------------------------------------------------------- */

export type PrepPlanSummaryUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type SummarizePrepPlanResult = {
  summary: PrepPlanSummary;
  usage: PrepPlanSummaryUsage;
  model: string;
  provider: string;
  /** How many provider calls this took (1 = first-try; >1 = a transient overload retried). */
  attempts?: number;
};

export interface PrepPlanSummarizer {
  summarize(facts: PrepPlanSummaryFacts): Promise<SummarizePrepPlanResult>;
}

/** The summary instruction. Optimized for practical, honest, quantity-safe prose. */
const SUMMARY_PROMPT = [
  'You are a friendly kitchen assistant turning a prep/reorder plan into a clear brief for',
  'the team. PrepProfit has already computed every quantity for you.',
  'Your ONLY job is to FORMAT these facts in plain, practical language. Return ONLY JSON',
  'matching the schema.',
  'Absolute rules:',
  '- NEVER calculate, estimate, or invent any quantity. Use only the numbers in the facts.',
  '- Quantities are whole canonical units by dimension: weight = grams (g), volume =',
  '  millilitres (ml), count = pieces. Present them with the right unit; do not convert.',
  '- There is NO money in this plan. Never mention prices, cost, or margin.',
  '- headline: one short sentence capturing the shift (e.g. big prep day, or a supply gap).',
  '- summary: 2-4 short sentences on what to prep and what to reorder/watch.',
  '- highlights: up to 4 short bullet strings for the most useful specifics (a large prep,',
  '  a big shortfall, an item about to dip below its threshold, a data gap to fix).',
  '- If any issues counts are > 0, remind the manager to fix those recipes (missing yield,',
  '  missing lines, or a deleted ingredient) so the plan is complete.',
  '- supplyRisk: low, medium, or high — how exposed the plan is (many shortfalls, low stock,',
  '  or data gaps push it up).',
  '- Be encouraging and concrete, never alarmist.',
].join('\n');

/**
 * Build the production Gemini-backed summarizer. Lazy: `aiEnv()` and the client
 * construction run on the first `summarize`, not at module load, keeping `next build`/CI
 * green without secrets. THROWS {@link PrepPlanSummaryError} on any provider/parse failure.
 * The key is never logged.
 */
export function getPrepPlanSummarizer(): PrepPlanSummarizer {
  return {
    async summarize(facts: PrepPlanSummaryFacts): Promise<SummarizePrepPlanResult> {
      const { apiKey } = aiEnv();
      const ai = new GoogleGenAI({ apiKey });

      let response;
      let attempts: number;
      try {
        ({ response, attempts } = await generateContentWithRetry(ai, {
          model: PREP_PLAN_SUMMARY_MODEL,
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
        throw new PrepPlanSummaryError(`Prep-plan summary request failed: ${reason}`, {
          retryable: isTransientProviderError(err),
        });
      }

      const text = response.text;
      if (!text) {
        throw new PrepPlanSummaryError('Model returned an empty response.');
      }

      const summary = parsePrepPlanSummaryResponse(text);
      const usage = response.usageMetadata;
      return {
        summary,
        usage: {
          inputTokens: usage?.promptTokenCount ?? null,
          outputTokens: usage?.candidatesTokenCount ?? null,
        },
        model: PREP_PLAN_SUMMARY_MODEL,
        provider: PREP_PLAN_SUMMARY_PROVIDER,
        attempts,
      };
    },
  };
}
