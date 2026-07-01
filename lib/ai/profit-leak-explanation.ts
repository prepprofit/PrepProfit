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
import type { ExplanationFacts } from '@/lib/calculations/explanation-facts';

/**
 * Profit-leak AI explanation provider seam (Sprint 4, AI margin roadmap).
 *
 * Mirrors `lib/ai/invoice-extraction.ts`: the app talks to the model through the small
 * {@link ProfitLeakExplainer} interface, never the SDK directly, so tests inject a fake
 * (no network/key) and the model id lives in ONE constant. CLAUDE.md "AI and import
 * rules": model output is UNTRUSTED — validated with {@link profitLeakExplanationSchema}
 * before it leaves this module. The critical Sprint-4 rule: the model is only EXPLAINING
 * numbers PrepProfit already computed. It receives compact {@link ExplanationFacts} (no
 * DB records) and returns prose + a risk label; it must NEVER calculate or invent a
 * money figure. The API key is read lazily via `aiEnv()` inside `explain()` and is
 * NEVER logged.
 */

/* -------------------------------------------------------------------------- */
/* Model config (the ONE place the provider/model id is pinned).              */
/* -------------------------------------------------------------------------- */

/**
 * The pinned explanation model. **Gemini 2.5 Flash (Stable)**: the same cheap, mature
 * model the invoice/photo paths settled on. Text-only here (facts in, prose out). SWAP
 * PATH: change this constant only (re-confirm the id at deploy time); a larger provider
 * change means swapping the body of {@link getProfitLeakExplainer} behind the unchanged
 * interface. Kept in {@link import('./pricing').GEMINI_PRICING} for cost estimation.
 */
export const PROFIT_LEAK_EXPLANATION_MODEL = 'gemini-2.5-flash';

/** The provider/vendor label recorded on each `ai_operation_attempts` row. */
export const PROFIT_LEAK_EXPLANATION_PROVIDER = 'google';

/* -------------------------------------------------------------------------- */
/* Strict result schema — the untrusted-input boundary.                       */
/* -------------------------------------------------------------------------- */

const MAX_HEADLINE_LEN = 120;
const MAX_EXPLANATION_LEN = 600;
const MAX_ACTION_LABEL_LEN = 80;

/**
 * The validated AI explanation (plan §9 output schema). Bounded string lengths so a
 * hallucinated/garbage response can never balloon memory or a UI card. `riskLevel` is
 * the model's qualitative read of the finding, NOT a money figure.
 */
export const profitLeakExplanationSchema = z.object({
  headline: z.string().trim().min(1).max(MAX_HEADLINE_LEN),
  explanation: z.string().trim().min(1).max(MAX_EXPLANATION_LEN),
  actionLabel: z.string().trim().min(1).max(MAX_ACTION_LABEL_LEN),
  riskLevel: z.enum(['low', 'medium', 'high']),
});
export type ProfitLeakExplanation = z.infer<typeof profitLeakExplanationSchema>;

/**
 * The Gemini structured-output (`responseSchema`) mirror of the Zod schema. Kept
 * adjacent so the two never drift: the model is asked to return EXACTLY this shape,
 * and the parsed result is still re-validated by Zod (defence in depth).
 */
const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    headline: { type: Type.STRING },
    explanation: { type: Type.STRING },
    actionLabel: { type: Type.STRING },
    riskLevel: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
  },
  required: ['headline', 'explanation', 'actionLabel', 'riskLevel'],
};

/**
 * Thrown when the model returns non-JSON, fails validation, or the provider call fails.
 * `retryable` is true when the underlying failure was a TRANSIENT provider
 * overload/rate-limit (a 429/5xx that survived our retries) rather than a genuine bad
 * response.
 */
export class ProfitLeakExplanationError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'ProfitLeakExplanationError';
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Parse + validate a raw model response into a strict {@link ProfitLeakExplanation}.
 * The untrusted-input boundary: invalid JSON or any schema violation throws
 * {@link ProfitLeakExplanationError} (key-free message) and never yields partial data.
 * Pure and SDK-free, so it is unit-tested against fixed fixtures without any network.
 */
export function parseProfitLeakExplanationResponse(
  rawText: string,
): ProfitLeakExplanation {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new ProfitLeakExplanationError('Model returned non-JSON output.');
  }
  const parsed = profitLeakExplanationSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProfitLeakExplanationError('Model output failed schema validation.');
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Transient-failure retry (identical policy to the extraction paths).       */
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
  throw new ProfitLeakExplanationError('Explanation exhausted all retries.');
}

/* -------------------------------------------------------------------------- */
/* Provider seam.                                                             */
/* -------------------------------------------------------------------------- */

export type ExplanationUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type ExplainProfitLeakResult = {
  explanation: ProfitLeakExplanation;
  usage: ExplanationUsage;
  model: string;
  provider: string;
  /** How many provider calls this took (1 = first-try; >1 = a transient overload retried). */
  attempts?: number;
};

export interface ProfitLeakExplainer {
  explain(facts: ExplanationFacts): Promise<ExplainProfitLeakResult>;
}

/** The explanation instruction. Optimized for practical, honest, number-free prose. */
const EXPLANATION_PROMPT = [
  'You are a friendly restaurant cost consultant helping a busy kitchen manager.',
  'PrepProfit has already detected a margin risk and computed every number for you.',
  'Your ONLY job is to EXPLAIN that finding in plain, practical language and say what',
  'to review. Return ONLY JSON matching the schema.',
  'Absolute rules:',
  '- NEVER calculate, estimate, or invent any number. Use only the figures given in the',
  '  facts. If a figure is null, do not mention or guess it.',
  '- Do not repeat every raw number; explain what the situation MEANS for profit.',
  '- headline: one short, specific sentence naming the item and the risk.',
  '- explanation: 2-4 short sentences on why it matters and what likely caused it,',
  '  grounded only in the given facts (e.g. an unpriced ingredient, a pending price rise).',
  '- actionLabel: a short imperative for the single most useful next step',
  '  (e.g. "Review selling price", "Add the missing ingredient price").',
  '- riskLevel: low, medium, or high — your qualitative read of how urgent this is.',
  '- Be encouraging and concrete, never alarmist.',
].join('\n');

/**
 * Build the production Gemini-backed explainer. Lazy: `aiEnv()` and the client
 * construction run on the first `explain`, not at module load, keeping `next build`/CI
 * green without secrets. THROWS {@link ProfitLeakExplanationError} on any provider/parse
 * failure. The key is never logged.
 */
export function getProfitLeakExplainer(): ProfitLeakExplainer {
  return {
    async explain(facts: ExplanationFacts): Promise<ExplainProfitLeakResult> {
      const { apiKey } = aiEnv();
      const ai = new GoogleGenAI({ apiKey });

      let response;
      let attempts: number;
      try {
        ({ response, attempts } = await generateContentWithRetry(ai, {
          model: PROFIT_LEAK_EXPLANATION_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                { text: EXPLANATION_PROMPT },
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
        throw new ProfitLeakExplanationError(
          `Profit-leak explanation request failed: ${reason}`,
          { retryable: isTransientProviderError(err) },
        );
      }

      const text = response.text;
      if (!text) {
        throw new ProfitLeakExplanationError('Model returned an empty response.');
      }

      const explanation = parseProfitLeakExplanationResponse(text);
      const usage = response.usageMetadata;
      return {
        explanation,
        usage: {
          inputTokens: usage?.promptTokenCount ?? null,
          outputTokens: usage?.candidatesTokenCount ?? null,
        },
        model: PROFIT_LEAK_EXPLANATION_MODEL,
        provider: PROFIT_LEAK_EXPLANATION_PROVIDER,
        attempts,
      };
    },
  };
}
