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
 * AI photo recipe extraction provider seam (Sprint 4.7).
 *
 * The whole app talks to the vision model through the small `RecipeExtractor`
 * interface, never the SDK directly, so:
 *   - tests `vi.mock('@/lib/ai/recipe-extraction')` and inject a recording /
 *     throwing fake (no network, no real API calls, no key), and
 *   - the extract action stays decoupled from the Gemini SDK shape, and the model
 *     id lives in ONE constant ({@link RECIPE_EXTRACTION_MODEL}) so swapping the
 *     provider/model is a single-line change.
 *
 * CLAUDE.md "AI and import rules": the model output is UNTRUSTED input. The raw
 * JSON the model returns is validated with {@link extractedRecipeSchema} before it
 * leaves this module ({@link parseExtractionResponse}); a malformed or out-of-range
 * response throws and never becomes data. Mapping the validated result into a
 * staged `ImportRecipePayload` (unit normalization, ingredient resolution) is a
 * separate, pure step (Sprint 4.7 step 3) — this module only extracts + validates.
 *
 * The API key is read lazily via `aiEnv()` inside `extract()` (never at import
 * time), so `next build` / CI stay green without secrets, and it is NEVER logged.
 */

/* -------------------------------------------------------------------------- */
/* Model config (the ONE place the provider/model id is pinned — D1).         */
/* -------------------------------------------------------------------------- */

/**
 * The pinned extraction model. **Gemini 2.5 Flash (Stable)**: cheap single-call
 * multimodal with native structured (JSON-schema) output and strong vision. Chosen
 * for AVAILABILITY: the newer `gemini-3.5-flash` returns chronic 503 "high demand"
 * under launch load (it survived every retry in the live eval), which makes the
 * whole photo-import feature look broken; 2.5 Flash is mature and responds reliably.
 * This is the only place the id appears.
 *
 * SWAP PATH (if this id is deprecated, a better model ships, or 3.5-flash's capacity
 * stabilizes): change this constant only. Re-confirm the exact id against
 * https://ai.google.dev/gemini-api/docs/models at deploy time. A larger provider
 * change (e.g. a Claude vision model) means swapping the body of
 * {@link getRecipeExtractor} behind the unchanged interface.
 */
export const RECIPE_EXTRACTION_MODEL = 'gemini-2.5-flash';

/** The provider/vendor label recorded on each `ai_extraction_attempts` row. */
export const RECIPE_EXTRACTION_PROVIDER = 'google';

/* -------------------------------------------------------------------------- */
/* Strict result schema — the untrusted-input boundary.                       */
/* -------------------------------------------------------------------------- */

/** Upper bounds so a hallucinated/garbage response can never balloon memory. */
const MAX_INGREDIENT_LINES = 200;
const MAX_NAME_LEN = 200;
const MAX_UNIT_LEN = 40;
const MAX_NOTES_LEN = 5000;
const MAX_PORTIONS = 100_000;
const MAX_RAWTEXT_LEN = 300;
const MAX_SECTION_LEN = 80;
const MAX_QTY_TEXT_LEN = 40;

/**
 * The model's read of overall photo legibility. An enum (not free prose) so it is
 * i18n-safe and feeds deterministic `quality_flags` in the mapping step, never a
 * raw string shown to the user.
 */
export const IMAGE_QUALITY = ['good', 'fair', 'poor'] as const;
export type ImageQuality = (typeof IMAGE_QUALITY)[number];

/**
 * One extracted ingredient line as the model READ it (not yet resolved). `quantity`
 * / `unit` are nullable: the model returns null for an unreadable or absent value
 * rather than inventing one. `unit` is the RAW token ("g", "cups", "pkt", "") — the
 * mapping step resolves it through the shared unit/descriptor parser (unknown ⇒ kept
 * for review, never a silent guess). `confidence` is the per-line certainty in [0, 1].
 *
 * The improvement-plan (Phase 2) fields are `.optional()` so an older/sparse response
 * still validates (defence in depth), but the prompt + `responseSchema` ask the model
 * to always return them:
 *  - `rawText`: the full source line, REVIEW-ONLY (never logged/audited).
 *  - `section`: a heading the line sits under (`Syrup`, `Filling`), for review grouping.
 *  - `quantityText`: the quantity EXACTLY as written (`1/2`, `1 1/2`, `½`). The server
 *    re-parses this (it never trusts the model's arithmetic); `quantity` is the model's
 *    best-effort numeric and the fallback.
 *  - `packageSizeValue`/`packageSizeUnit`: a parenthetical pack size (`1 pkt (300 g)`),
 *    captured separately so a descriptor line can canonicalize from the pack.
 *  - `crossedOut`: a struck-through line — returned (so we can explain it) but ignored.
 */
export const extractedLineSchema = z.object({
  rawText: z.string().trim().max(MAX_RAWTEXT_LEN).nullable().optional(),
  section: z.string().trim().max(MAX_SECTION_LEN).nullable().optional(),
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  quantityText: z.string().trim().max(MAX_QTY_TEXT_LEN).nullable().optional(),
  quantity: z.number().positive().finite().nullable(),
  unit: z.string().trim().max(MAX_UNIT_LEN).nullable(),
  packageSizeValue: z.number().positive().finite().nullable().optional(),
  packageSizeUnit: z.string().trim().max(MAX_UNIT_LEN).nullable().optional(),
  crossedOut: z.boolean().optional(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedLine = z.infer<typeof extractedLineSchema>;

/**
 * The full validated extraction. `yieldPortions` is nullable (often absent on a
 * photo); `preparationNotes` is extracted recipe text the user reviews (same class
 * as ingredient names — recipe data, not raw image bytes). `overallConfidence`
 * and `imageQuality` drive the preview's quality warnings.
 */
export const extractedRecipeSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  yieldPortions: z.number().int().positive().max(MAX_PORTIONS).nullable(),
  ingredients: z.array(extractedLineSchema).max(MAX_INGREDIENT_LINES),
  preparationNotes: z.string().trim().max(MAX_NOTES_LEN).nullable(),
  overallConfidence: z.number().min(0).max(1),
  imageQuality: z.enum(IMAGE_QUALITY),
});
export type ExtractedRecipe = z.infer<typeof extractedRecipeSchema>;

/**
 * The Gemini structured-output (`responseSchema`) mirror of `extractedRecipeSchema`.
 * Kept adjacent so the two never drift: the model is asked to return EXACTLY this
 * shape, and the parsed result is still re-validated by the Zod schema (defence in
 * depth — structured output is a hint, not a guarantee).
 */
const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    yieldPortions: { type: Type.INTEGER, nullable: true },
    ingredients: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rawText: { type: Type.STRING, nullable: true },
          section: { type: Type.STRING, nullable: true },
          name: { type: Type.STRING },
          quantityText: { type: Type.STRING, nullable: true },
          quantity: { type: Type.NUMBER, nullable: true },
          unit: { type: Type.STRING, nullable: true },
          packageSizeValue: { type: Type.NUMBER, nullable: true },
          packageSizeUnit: { type: Type.STRING, nullable: true },
          crossedOut: { type: Type.BOOLEAN },
          confidence: { type: Type.NUMBER },
        },
        required: [
          'rawText',
          'section',
          'name',
          'quantityText',
          'quantity',
          'unit',
          'packageSizeValue',
          'packageSizeUnit',
          'crossedOut',
          'confidence',
        ],
      },
    },
    preparationNotes: { type: Type.STRING, nullable: true },
    overallConfidence: { type: Type.NUMBER },
    imageQuality: { type: Type.STRING, enum: [...IMAGE_QUALITY] },
  },
  required: [
    'name',
    'yieldPortions',
    'ingredients',
    'preparationNotes',
    'overallConfidence',
    'imageQuality',
  ],
};

/**
 * Thrown when the model returns non-JSON, fails validation, or the provider call
 * fails. `retryable` is true when the underlying failure was a TRANSIENT provider
 * overload/rate-limit (a 429/5xx that survived our in-extractor retries) rather than
 * a genuine "couldn't read this photo". The route uses it to show the user an honest
 * "service is busy, try again" message instead of wrongly blaming their image.
 */
export class RecipeExtractionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'RecipeExtractionError';
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Parse + validate a raw model response (the JSON string the model returned) into
 * a strict {@link ExtractedRecipe}. The untrusted-input boundary: invalid JSON or
 * any schema violation throws {@link RecipeExtractionError} (key-free message) and
 * never yields partial data. Pure and SDK-free, so it is unit-tested against fixed
 * fixtures without any network.
 */
export function parseExtractionResponse(rawText: string): ExtractedRecipe {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new RecipeExtractionError('Model returned non-JSON output.');
  }
  const parsed = extractedRecipeSchema.safeParse(json);
  if (!parsed.success) {
    throw new RecipeExtractionError('Model output failed schema validation.');
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Transient-failure retry.                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Gemini returns a 503 ("This model is currently experiencing high demand") or a
 * 429 (rate limited) under load — both transient. A brand-new, popular Flash model
 * is routinely overloaded, so a single attempt fails often enough to make the whole
 * photo-import feature look broken to the user. We retry the call a few times with
 * exponential backoff + full jitter; a non-transient error (e.g. 400 bad request,
 * 404 unknown model, or a validation failure) fails fast and is NOT retried. Total
 * added latency is bounded (~0.4s + ~0.8s worst case before the final attempt) so
 * the upload request stays well within the function timeout.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A transient provider failure worth retrying — an `ApiError` with a 429/5xx status. */
function isTransientProviderError(err: unknown): boolean {
  return err instanceof ApiError && RETRYABLE_STATUS.has(err.status);
}

/**
 * Call `generateContent`, retrying transient overload/rate-limit failures with
 * exponential backoff. Re-throws the last error once attempts are exhausted (the
 * caller wraps it as a key-free {@link RecipeExtractionError}).
 */
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
      // Full jitter over an exponentially growing window: [0, 400), [0, 800), …
      const window = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(Math.random() * window);
    }
  }
  // Unreachable: the loop returns on success or throws on the final attempt.
  throw new RecipeExtractionError('Recipe extraction exhausted all retries.');
}

/* -------------------------------------------------------------------------- */
/* Provider seam.                                                             */
/* -------------------------------------------------------------------------- */

/** The (already MIME-validated, in-memory) image to extract from. */
export type ExtractRecipeInput = {
  imageBytes: Buffer;
  /** An allowlisted image mime (`image/jpeg|png|webp`), checked by the upload route. */
  mimeType: string;
};

/** Token usage for the call, for cost observability (null when unreported). */
export type ExtractionUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type ExtractRecipeResult = {
  recipe: ExtractedRecipe;
  usage: ExtractionUsage;
  /** The model id used (recorded on the attempt row for traceability). */
  model: string;
  provider: string;
  /**
   * How many provider calls this extraction took (1 = first-try success; >1 = a
   * transient overload was retried). Optional and additive: the production extractor
   * sets it for the eval harness's retry-rate metric (§9 / Phase 5); test fakes and
   * older callers may omit it. Never persisted as PII — a count only.
   */
  attempts?: number;
};

export interface RecipeExtractor {
  extract(input: ExtractRecipeInput): Promise<ExtractRecipeResult>;
}

/**
 * The extraction instruction (improvement-plan Phase 2). Optimized for completeness:
 * EVERY active line must be returned — a rough line we can review beats a missing one.
 * Sections, raw quantity text, parenthetical pack sizes, and crossed-out state are all
 * captured so the deterministic mapper/review UI can correct rather than discard.
 */
const EXTRACTION_PROMPT = [
  'You are extracting a single cooking recipe from one photograph of a recipe',
  '(printed card, cookbook page, supplier sheet, or handwritten note).',
  'Return ONLY the recipe shown, as JSON matching the schema. Rules:',
  '- Extract EVERY active ingredient line. Completeness matters most: never omit a',
  '  line just because a value is hard to read.',
  '- NEVER invent ingredients, quantities, or units. If a value is missing or',
  '  unreadable, return null for it — do not guess.',
  '- For each line set rawText to the full line exactly as written.',
  '- Preserve section headings (e.g. "Syrup", "Filling", "Dough", "Sauce") in section;',
  '  use null when the line sits under no heading. Do NOT fold a section into the name.',
  '- Set quantityText to the quantity EXACTLY as written, including fractions',
  '  ("1/2", "1 1/2", "½"). Also set quantity to your best-effort numeric value, or',
  '  null if you cannot read a number. Keep unit as the raw token shown',
  '  ("g", "cups", "tbsp", "tsp", "pkt", "clove").',
  '- If a line shows a parenthetical pack size, capture it SEPARATELY:',
  '  "1 pkt walnuts (300g)" -> quantity 1, unit "pkt", packageSizeValue 300,',
  '  packageSizeUnit "g". Otherwise packageSizeValue and packageSizeUnit are null.',
  '- Set crossedOut true for a clearly struck-through/deleted line (still return it so',
  '  it can be explained); otherwise false.',
  '- Give a confidence in [0,1] per ingredient line and one overall, and rate the',
  '  image legibility as "good", "fair", or "poor".',
  '- Put method/preparation steps (if any) in preparationNotes, else null.',
  '',
  'Example (handwritten, sectioned, with a pack size and a crossed-out line):',
  JSON.stringify({
    name: 'Walnut Tart',
    yieldPortions: 8,
    ingredients: [
      {
        rawText: '1 pkt walnuts (300g)',
        section: 'Filling',
        name: 'Walnuts',
        quantityText: '1',
        quantity: 1,
        unit: 'pkt',
        packageSizeValue: 300,
        packageSizeUnit: 'g',
        crossedOut: false,
        confidence: 0.9,
      },
      {
        rawText: '½ cup honey',
        section: 'Syrup',
        name: 'Honey',
        quantityText: '½',
        quantity: 0.5,
        unit: 'cup',
        packageSizeValue: null,
        packageSizeUnit: null,
        crossedOut: false,
        confidence: 0.88,
      },
      {
        rawText: '2 tbsp brandy',
        section: 'Syrup',
        name: 'Brandy',
        quantityText: '2',
        quantity: 2,
        unit: 'tbsp',
        packageSizeValue: null,
        packageSizeUnit: null,
        crossedOut: true,
        confidence: 0.7,
      },
    ],
    preparationNotes: 'Toast the walnuts; layer; pour over syrup.',
    overallConfidence: 0.86,
    imageQuality: 'fair',
  }),
].join('\n');

/**
 * Build the production Gemini-backed extractor. Lazy: `aiEnv()` (and thus the key
 * assertion) and the client construction run on the first `extract`, not at module
 * load, keeping `next build` / CI green without secrets. THROWS
 * {@link RecipeExtractionError} on any provider/parse failure — the action catches
 * it and maps to the stable `AI_EXTRACTION_FAILED` code. The key is never logged.
 */
export function getRecipeExtractor(): RecipeExtractor {
  return {
    async extract(input: ExtractRecipeInput): Promise<ExtractRecipeResult> {
      const { apiKey } = aiEnv();
      const ai = new GoogleGenAI({ apiKey });

      let response;
      let attempts: number;
      try {
        ({ response, attempts } = await generateContentWithRetry(ai, {
          model: RECIPE_EXTRACTION_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: input.mimeType,
                    data: input.imageBytes.toString('base64'),
                  },
                },
                { text: EXTRACTION_PROMPT },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema,
            // Deterministic transcription: no creative sampling.
            temperature: 0,
          },
        }));
      } catch (err) {
        // Surface a key-free message; the caller logs it and returns the stable code.
        // A transient overload that survived every retry is flagged `retryable` so the
        // user is told the service is busy, not that their photo was unreadable.
        const reason = err instanceof Error ? err.message : 'unknown error';
        throw new RecipeExtractionError(`Recipe extraction request failed: ${reason}`, {
          retryable: isTransientProviderError(err),
        });
      }

      const text = response.text;
      if (!text) throw new RecipeExtractionError('Model returned an empty response.');

      const recipe = parseExtractionResponse(text);
      const usage = response.usageMetadata;
      return {
        recipe,
        usage: {
          inputTokens: usage?.promptTokenCount ?? null,
          outputTokens: usage?.candidatesTokenCount ?? null,
        },
        model: RECIPE_EXTRACTION_MODEL,
        provider: RECIPE_EXTRACTION_PROVIDER,
        attempts,
      };
    },
  };
}
