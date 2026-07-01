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

/**
 * Supplier Invoice Reader provider seam (Sprint 2, AI margin roadmap).
 *
 * Mirrors `lib/ai/recipe-extraction.ts`: the app talks to the model through the small
 * {@link InvoiceExtractor} interface, never the SDK directly, so tests inject a fake
 * (no network/key) and the model id lives in ONE constant. CLAUDE.md "AI and import
 * rules": the model output is UNTRUSTED — it is validated with
 * {@link supplierInvoiceExtractionSchema} before it leaves this module, and even a
 * validated price is only ever recorded as a PENDING observation downstream (never an
 * approved cost). The API key is read lazily via `aiEnv()` inside `extract()` and is
 * NEVER logged.
 */

/* -------------------------------------------------------------------------- */
/* Model config (the ONE place the provider/model id is pinned).              */
/* -------------------------------------------------------------------------- */

/**
 * The pinned invoice-extraction model. **Gemini 2.5 Flash (Stable)**: mature, cheap,
 * multimodal (image + PDF) with native structured (JSON-schema) output — the same
 * model the photo path settled on for availability. SWAP PATH: change this constant
 * only (re-confirm the id at deploy time); a larger provider change means swapping the
 * body of {@link getInvoiceExtractor} behind the unchanged interface.
 */
export const INVOICE_EXTRACTION_MODEL = 'gemini-2.5-flash';

/** The provider/vendor label recorded on each `ai_operation_attempts` row. */
export const INVOICE_EXTRACTION_PROVIDER = 'google';

/* -------------------------------------------------------------------------- */
/* Strict result schema — the untrusted-input boundary.                       */
/* -------------------------------------------------------------------------- */

/** Upper bounds so a hallucinated/garbage response can never balloon memory. */
const MAX_LINES = 300;
const MAX_NAME_LEN = 200;
const MAX_RAWTEXT_LEN = 300;
const MAX_UNIT_LEN = 40;
const MAX_NUMBER_LEN = 100;
const MAX_DATE_LEN = 20;
const MAX_CURRENCY_LEN = 3;
const MAX_FLAG_LEN = 80;
const MAX_FLAGS = 20;

/**
 * One extracted invoice line as the model READ it (not yet resolved). Amounts are
 * nullable — the model returns null for an unreadable/absent value rather than
 * inventing one. `unitPriceCents`/`lineTotalCents` are integer cents. `confidence` is
 * the per-line certainty in [0, 1].
 */
export const invoiceLineSchema = z.object({
  rawText: z.string().trim().max(MAX_RAWTEXT_LEN).nullable(),
  itemName: z.string().trim().min(1).max(MAX_NAME_LEN),
  quantityValue: z.number().positive().finite().nullable(),
  quantityUnit: z.string().trim().max(MAX_UNIT_LEN).nullable(),
  packSizeValue: z.number().positive().finite().nullable(),
  packSizeUnit: z.string().trim().max(MAX_UNIT_LEN).nullable(),
  unitPriceCents: z.number().int().nonnegative().nullable(),
  lineTotalCents: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

/** The full validated invoice extraction. */
export const supplierInvoiceExtractionSchema = z.object({
  supplier: z.object({
    name: z.string().trim().max(MAX_NAME_LEN).nullable(),
    confidence: z.number().min(0).max(1),
  }),
  invoice: z.object({
    number: z.string().trim().max(MAX_NUMBER_LEN).nullable(),
    date: z.string().trim().max(MAX_DATE_LEN).nullable(),
    currency: z.string().trim().max(MAX_CURRENCY_LEN).nullable(),
  }),
  lines: z.array(invoiceLineSchema).max(MAX_LINES),
  qualityFlags: z.array(z.string().trim().max(MAX_FLAG_LEN)).max(MAX_FLAGS),
});
export type SupplierInvoiceExtraction = z.infer<
  typeof supplierInvoiceExtractionSchema
>;

/**
 * The Gemini structured-output (`responseSchema`) mirror of the Zod schema. Kept
 * adjacent so the two never drift: the model is asked to return EXACTLY this shape,
 * and the parsed result is still re-validated by Zod (defence in depth).
 */
const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    supplier: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, nullable: true },
        confidence: { type: Type.NUMBER },
      },
      required: ['name', 'confidence'],
    },
    invoice: {
      type: Type.OBJECT,
      properties: {
        number: { type: Type.STRING, nullable: true },
        date: { type: Type.STRING, nullable: true },
        currency: { type: Type.STRING, nullable: true },
      },
      required: ['number', 'date', 'currency'],
    },
    lines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rawText: { type: Type.STRING, nullable: true },
          itemName: { type: Type.STRING },
          quantityValue: { type: Type.NUMBER, nullable: true },
          quantityUnit: { type: Type.STRING, nullable: true },
          packSizeValue: { type: Type.NUMBER, nullable: true },
          packSizeUnit: { type: Type.STRING, nullable: true },
          unitPriceCents: { type: Type.INTEGER, nullable: true },
          lineTotalCents: { type: Type.INTEGER, nullable: true },
          confidence: { type: Type.NUMBER },
        },
        required: [
          'rawText',
          'itemName',
          'quantityValue',
          'quantityUnit',
          'packSizeValue',
          'packSizeUnit',
          'unitPriceCents',
          'lineTotalCents',
          'confidence',
        ],
      },
    },
    qualityFlags: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['supplier', 'invoice', 'lines', 'qualityFlags'],
};

/**
 * Thrown when the model returns non-JSON, fails validation, or the provider call
 * fails. `retryable` is true when the underlying failure was a TRANSIENT provider
 * overload/rate-limit (a 429/5xx that survived our retries) rather than a genuine
 * "couldn't read this invoice".
 */
export class InvoiceExtractionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'InvoiceExtractionError';
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Parse + validate a raw model response into a strict {@link SupplierInvoiceExtraction}.
 * The untrusted-input boundary: invalid JSON or any schema violation throws
 * {@link InvoiceExtractionError} (key-free message) and never yields partial data. Pure
 * and SDK-free, so it is unit-tested against fixed fixtures without any network.
 */
export function parseInvoiceExtractionResponse(
  rawText: string,
): SupplierInvoiceExtraction {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new InvoiceExtractionError('Model returned non-JSON output.');
  }
  const parsed = supplierInvoiceExtractionSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvoiceExtractionError('Model output failed schema validation.');
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Transient-failure retry (identical policy to the photo path).             */
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
  throw new InvoiceExtractionError('Invoice extraction exhausted all retries.');
}

/* -------------------------------------------------------------------------- */
/* Provider seam.                                                             */
/* -------------------------------------------------------------------------- */

/** The (already validated, in-memory) document to extract from — image OR PDF. */
export type ExtractInvoiceInput = {
  documentBytes: Buffer;
  /** An allowlisted mime (image/jpeg|png|webp or application/pdf), checked by the route. */
  mimeType: string;
};

export type InvoiceExtractionUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type ExtractInvoiceResult = {
  invoice: SupplierInvoiceExtraction;
  usage: InvoiceExtractionUsage;
  model: string;
  provider: string;
  /** How many provider calls this took (1 = first-try; >1 = a transient overload retried). */
  attempts?: number;
};

export interface InvoiceExtractor {
  extract(input: ExtractInvoiceInput): Promise<ExtractInvoiceResult>;
}

/** The extraction instruction. Optimized for completeness + honesty (no guessing). */
const EXTRACTION_PROMPT = [
  'You are extracting the purchased line items from ONE supplier invoice or delivery',
  'note (a photo or a PDF). Return ONLY the data shown, as JSON matching the schema.',
  'Rules:',
  '- Read the supplier name and, if present, the invoice number, date, and currency',
  '  (as a 3-letter ISO code when shown). Use null for anything not clearly shown.',
  '- Extract EVERY purchased line item. Never omit a line just because a value is',
  '  hard to read.',
  '- NEVER invent names, quantities, pack sizes, units, or prices. If a value is',
  '  missing or unreadable, return null for it — do not guess.',
  '- Set rawText to the full line exactly as written.',
  '- itemName is the product name only (no quantity/price/codes).',
  '- quantityValue/quantityUnit: how many units were bought (e.g. 6, "case").',
  '- packSizeValue/packSizeUnit: the size of ONE pack (e.g. a 5 kg sack -> 5, "kg").',
  '- unitPriceCents: the price of ONE pack in minor currency units (cents), integer.',
  '- lineTotalCents: the line total in cents, integer, when shown.',
  '- Give a confidence in [0,1] per line and for the supplier match.',
  '- Put brief machine-readable notes about anything ambiguous (e.g. "vat_unclear",',
  '  "handwritten", "currency_missing") into qualityFlags.',
].join('\n');

/**
 * Build the production Gemini-backed invoice extractor. Lazy: `aiEnv()` and the client
 * construction run on the first `extract`, not at module load, keeping `next build`/CI
 * green without secrets. THROWS {@link InvoiceExtractionError} on any provider/parse
 * failure. The key is never logged.
 */
export function getInvoiceExtractor(): InvoiceExtractor {
  return {
    async extract(input: ExtractInvoiceInput): Promise<ExtractInvoiceResult> {
      const { apiKey } = aiEnv();
      const ai = new GoogleGenAI({ apiKey });

      let response;
      let attempts: number;
      try {
        ({ response, attempts } = await generateContentWithRetry(ai, {
          model: INVOICE_EXTRACTION_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: input.mimeType,
                    data: input.documentBytes.toString('base64'),
                  },
                },
                { text: EXTRACTION_PROMPT },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema,
            temperature: 0,
          },
        }));
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        throw new InvoiceExtractionError(`Invoice extraction request failed: ${reason}`, {
          retryable: isTransientProviderError(err),
        });
      }

      const text = response.text;
      if (!text) throw new InvoiceExtractionError('Model returned an empty response.');

      const invoice = parseInvoiceExtractionResponse(text);
      const usage = response.usageMetadata;
      return {
        invoice,
        usage: {
          inputTokens: usage?.promptTokenCount ?? null,
          outputTokens: usage?.candidatesTokenCount ?? null,
        },
        model: INVOICE_EXTRACTION_MODEL,
        provider: INVOICE_EXTRACTION_PROVIDER,
        attempts,
      };
    },
  };
}
