import { GoogleGenAI, Type, type Schema } from '@google/genai';
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
 * The pinned extraction model. **GA Gemini 3 Flash** (decision D1/Q3): cheap
 * single-call multimodal with native structured (JSON-schema) output and strong
 * vision. This is the only place the id appears.
 *
 * SWAP PATH (if this id is deprecated or a better model ships): change this
 * constant only. The provider is GA, not Preview, so no preview-deprecation risk;
 * the exact GA id should be re-confirmed against https://ai.google.dev/gemini-api/docs/models
 * at deploy time. A larger provider change (e.g. a Claude vision model) means
 * swapping the body of {@link getRecipeExtractor} behind the unchanged interface.
 */
export const RECIPE_EXTRACTION_MODEL = 'gemini-3-flash';

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
 * rather than inventing one. `unit` is the RAW token ("g", "cups", "") — the mapping
 * step resolves it through the shared unit parser (unknown ⇒ a row issue, never a
 * silent guess). `confidence` is the model's per-line certainty in [0, 1].
 */
export const extractedLineSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  quantity: z.number().positive().finite().nullable(),
  unit: z.string().trim().max(MAX_UNIT_LEN).nullable(),
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
          name: { type: Type.STRING },
          quantity: { type: Type.NUMBER, nullable: true },
          unit: { type: Type.STRING, nullable: true },
          confidence: { type: Type.NUMBER },
        },
        required: ['name', 'quantity', 'unit', 'confidence'],
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

/** Thrown when the model returns non-JSON or a response that fails validation. */
export class RecipeExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeExtractionError';
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
};

export interface RecipeExtractor {
  extract(input: ExtractRecipeInput): Promise<ExtractRecipeResult>;
}

/** The extraction instruction. Optimized for printed/typed sources (Q1). */
const EXTRACTION_PROMPT = [
  'You are extracting a single cooking recipe from one photograph of a recipe',
  '(printed card, cookbook page, supplier sheet, or handwritten note).',
  'Return ONLY the recipe shown. Follow these rules strictly:',
  '- Transcribe the recipe title, the yield in portions if stated, and every',
  '  ingredient line with its quantity and unit exactly as written.',
  '- NEVER invent ingredients, quantities, or units. If a value is missing or',
  '  unreadable, return null for it — do not guess.',
  '- Keep each ingredient unit as the raw token shown (e.g. "g", "cups", "tbsp").',
  '- Give a confidence in [0,1] per ingredient line and one overall, and rate the',
  '  image legibility as "good", "fair", or "poor".',
  '- Put method/preparation steps (if any) in preparationNotes, else null.',
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
      try {
        response = await ai.models.generateContent({
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
        });
      } catch (err) {
        // Surface a key-free message; the caller logs it and returns the stable code.
        const reason = err instanceof Error ? err.message : 'unknown error';
        throw new RecipeExtractionError(`Recipe extraction request failed: ${reason}`);
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
      };
    },
  };
}
