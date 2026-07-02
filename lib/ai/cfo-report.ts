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
import type { CfoReport } from '@/lib/calculations/cfo-report';

/**
 * Weekly CFO Report AI provider seam (Sprint 8, AI margin roadmap; plan §13).
 *
 * Mirrors `lib/ai/daily-close-summary.ts`: the app talks to the model through the small
 * {@link CfoReportSummarizer} interface, never the SDK directly, so tests inject a fake (no
 * network/key) and the model id lives in ONE constant. CLAUDE.md "AI and import rules": model
 * output is UNTRUSTED — validated with {@link cfoReportSummarySchema} before it leaves this
 * module. The Sprint-8 rule (plan §13): the model may only NARRATE the report PrepProfit
 * already computed deterministically ({@link CfoReport}); it receives compact
 * {@link CfoReportFacts} (no DB rows) and must NEVER calculate a trend or invent a figure. The
 * report IS financial (manager-only), so — unlike the money-free prep-plan facts — the facts
 * carry integer cents + a currency code the model presents verbatim. The API key is read
 * lazily via `aiEnv()` inside `summarize()` and is NEVER logged.
 */

/* -------------------------------------------------------------------------- */
/* Model config (the ONE place the provider/model id is pinned).              */
/* -------------------------------------------------------------------------- */

/** The pinned summary model — the same cheap, mature text model the other AI paths use. */
export const CFO_REPORT_MODEL = 'gemini-2.5-flash';
/** The provider/vendor label recorded on each `ai_operation_attempts` row. */
export const CFO_REPORT_PROVIDER = 'google';

/* -------------------------------------------------------------------------- */
/* Strict result schema — the untrusted-input boundary.                       */
/* -------------------------------------------------------------------------- */

const MAX_HEADLINE_LEN = 140;
const MAX_SUMMARY_LEN = 1_000;
const MAX_HIGHLIGHT_LEN = 180;
const MAX_HIGHLIGHTS = 5;

/**
 * The validated AI write-up (plan §13 output). Bounded string lengths + a capped highlight
 * list so a hallucinated/garbage response can never balloon memory or the UI. `riskLevel` is
 * the model's qualitative read of how much the week needs the owner's attention — NOT a money
 * figure.
 */
export const cfoReportSummarySchema = z.object({
  headline: z.string().trim().min(1).max(MAX_HEADLINE_LEN),
  summary: z.string().trim().min(1).max(MAX_SUMMARY_LEN),
  highlights: z
    .array(z.string().trim().min(1).max(MAX_HIGHLIGHT_LEN))
    .max(MAX_HIGHLIGHTS)
    .default([]),
  riskLevel: z.enum(['low', 'medium', 'high']),
});
export type CfoReportSummary = z.infer<typeof cfoReportSummarySchema>;

/** The Gemini structured-output mirror of the Zod schema (kept adjacent so they can't drift). */
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
export class CfoReportError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'CfoReportError';
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Parse + validate a raw model response into a strict {@link CfoReportSummary}. The
 * untrusted-input boundary: invalid JSON or any schema violation throws {@link CfoReportError}
 * (key-free message) and never yields partial data. Pure and SDK-free, so it is unit-tested
 * against fixed fixtures without any network.
 */
export function parseCfoReportResponse(rawText: string): CfoReportSummary {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new CfoReportError('Model returned non-JSON output.');
  }
  const parsed = cfoReportSummarySchema.safeParse(json);
  if (!parsed.success) {
    throw new CfoReportError('Model output failed schema validation.');
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Facts — the compact, structured input the model receives (pure, SDK-free).  */
/* -------------------------------------------------------------------------- */

/**
 * The exact payload sent to the model. Deliberately compact: descriptors + the figures
 * PrepProfit ALREADY computed (so it is exactly what the manager sees), never DB records.
 * Money is integer cents + a currency code so the model can present amounts without doing
 * arithmetic. Nothing here is derived by the model.
 */
export type CfoReportFacts = {
  weekFrom: string;
  weekTo: string;
  currency: string;
  targetMarginPercent: number;
  revenue: {
    thisWeekGrossCents: number;
    priorWeekGrossCents: number;
    thisWeekNetCents: number;
    priorWeekNetCents: number;
    changePercent: number | null;
    direction: 'up' | 'down' | 'flat';
  };
  foodCost: {
    thisWeekPercent: number | null;
    priorWeekPercent: number | null;
    changePoints: number | null;
    direction: 'up' | 'down' | 'flat';
    thisWeekComplete: boolean;
  };
  marginLeaks: { name: string; kind: string; marginPercent: number | null; severity: string }[];
  repriceCandidates: {
    name: string;
    marginPercent: number;
    currentCostCents: number;
    suggestedPriceCents: number | null;
  }[];
  supplierPriceChanges: {
    name: string;
    fromCents: number;
    toCents: number;
    changePercent: number | null;
    direction: 'up' | 'down';
  }[];
  lowStock: { name: string; dimension: Dimension; onHand: number; threshold: number }[];
  confidence: { code: string; count: number }[];
};

/** Cap the list sizes sent to the model — the tail adds tokens, not signal. */
const MAX_FACT_ITEMS = 8;

/**
 * Distil the deterministic report into the model's fact input (pure). Every figure comes
 * straight off {@link CfoReport}; this never derives or fabricates a number. The caller passes
 * the org currency for presentation only.
 */
export function buildCfoReportFacts(report: CfoReport, currency: string): CfoReportFacts {
  return {
    weekFrom: report.weekFrom,
    weekTo: report.weekTo,
    currency,
    targetMarginPercent: report.targetMarginPercent,
    revenue: {
      thisWeekGrossCents: report.revenue.thisWeekGrossCents,
      priorWeekGrossCents: report.revenue.priorWeekGrossCents,
      thisWeekNetCents: report.revenue.thisWeekNetCents,
      priorWeekNetCents: report.revenue.priorWeekNetCents,
      changePercent: report.revenue.changePercent,
      direction: report.revenue.direction,
    },
    foodCost: {
      thisWeekPercent: report.foodCost.thisWeekPercent,
      priorWeekPercent: report.foodCost.priorWeekPercent,
      changePoints: report.foodCost.changePoints,
      direction: report.foodCost.direction,
      thisWeekComplete: report.foodCost.thisWeekComplete,
    },
    marginLeaks: report.marginLeaks.slice(0, MAX_FACT_ITEMS).map((f) => ({
      name: f.entityName,
      kind: f.entityType,
      marginPercent: f.currentMarginPercent,
      severity: f.severity,
    })),
    repriceCandidates: report.repriceCandidates.slice(0, MAX_FACT_ITEMS).map((c) => ({
      name: c.entityName,
      marginPercent: c.currentMarginPercent,
      currentCostCents: c.currentCostCents,
      suggestedPriceCents: c.suggestedPriceCents,
    })),
    supplierPriceChanges: report.supplierPriceChanges.slice(0, MAX_FACT_ITEMS).map((c) => ({
      name: c.name,
      fromCents: c.fromCents,
      toCents: c.toCents,
      changePercent: c.changePercent,
      direction: c.direction,
    })),
    lowStock: report.lowStock.slice(0, MAX_FACT_ITEMS).map((l) => ({
      name: l.name,
      dimension: l.dimension,
      onHand: l.onHandCanonical,
      threshold: l.thresholdCanonical,
    })),
    confidence: report.confidence.map((c) => ({ code: c.code, count: c.count })),
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
  throw new CfoReportError('Report exhausted all retries.');
}

/* -------------------------------------------------------------------------- */
/* Provider seam.                                                             */
/* -------------------------------------------------------------------------- */

export type CfoReportUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type SummarizeCfoReportResult = {
  summary: CfoReportSummary;
  usage: CfoReportUsage;
  model: string;
  provider: string;
  /** How many provider calls this took (1 = first-try; >1 = a transient overload retried). */
  attempts?: number;
};

export interface CfoReportSummarizer {
  summarize(facts: CfoReportFacts): Promise<SummarizeCfoReportResult>;
}

/** The write-up instruction. Optimized for a practical, honest, number-safe CFO brief. */
const REPORT_PROMPT = [
  'You are a friendly CFO writing a short weekly brief for the owner of a small food',
  'business. PrepProfit has already computed every number for you.',
  'Your ONLY job is to NARRATE these facts in plain, practical language. Return ONLY JSON',
  'matching the schema.',
  'Absolute rules:',
  '- NEVER calculate, estimate, or invent any number. Use only the figures in the facts.',
  '  If a figure is null, do not mention or guess it.',
  '- Present money amounts in the given currency exactly as provided; do not re-derive them.',
  '- Food cost is over NET sales; a RISING food-cost % (direction "up") is bad, a FALLING one',
  '  is good. Revenue "up" is good. Frame each trend accordingly.',
  '- If foodCost.thisWeekComplete is false, say the food cost is PARTIAL because some sold',
  '  items are not yet priced. Never imply it is final.',
  '- headline: one short sentence capturing the week for the owner.',
  '- summary: 3-5 short sentences covering revenue trend, food-cost trend, the biggest margin',
  '  leaks or items to reprice, and any notable supplier price change or low stock.',
  '- highlights: up to 5 short bullet strings for the most useful specifics (a reprice with',
  '  its suggested price, a big supplier increase, an item about to run out).',
  '- If any confidence notes are present, briefly tell the owner what limits the report',
  "  (no sales, no prior-week baseline, partial food cost, unpriced ingredients, incomplete",
  '  menus) so they trust the numbers only as far as the data allows.',
  '- riskLevel: low, medium, or high — how much this week needs the owner’s attention',
  '  (rising food cost, thin margins, big price increases, or low stock push it up).',
  '- Be encouraging and concrete, never alarmist.',
].join('\n');

/**
 * Build the production Gemini-backed summarizer. Lazy: `aiEnv()` and the client construction
 * run on the first `summarize`, not at module load, keeping `next build`/CI green without
 * secrets. THROWS {@link CfoReportError} on any provider/parse failure. The key is never
 * logged.
 */
export function getCfoReportSummarizer(): CfoReportSummarizer {
  return {
    async summarize(facts: CfoReportFacts): Promise<SummarizeCfoReportResult> {
      const { apiKey } = aiEnv();
      const ai = new GoogleGenAI({ apiKey });

      let response;
      let attempts: number;
      try {
        ({ response, attempts } = await generateContentWithRetry(ai, {
          model: CFO_REPORT_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                { text: REPORT_PROMPT },
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
        throw new CfoReportError(`CFO report request failed: ${reason}`, {
          retryable: isTransientProviderError(err),
        });
      }

      const text = response.text;
      if (!text) {
        throw new CfoReportError('Model returned an empty response.');
      }

      const summary = parseCfoReportResponse(text);
      const usage = response.usageMetadata;
      return {
        summary,
        usage: {
          inputTokens: usage?.promptTokenCount ?? null,
          outputTokens: usage?.candidatesTokenCount ?? null,
        },
        model: CFO_REPORT_MODEL,
        provider: CFO_REPORT_PROVIDER,
        attempts,
      };
    },
  };
}
