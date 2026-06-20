/**
 * Dependency-free shared types for AI photo recipe extraction (Sprint 4.7).
 *
 * Like `lib/import/types.ts`, this module is intentionally IMPORT-FREE (no Drizzle
 * schema, no SDK, no zod) so it can be imported by `lib/db/schema.ts` for the
 * `ai_extraction_attempts` column `$type`s without dragging the Gemini SDK into the
 * schema / migration tooling. The SDK-coupled extractor + Zod validation live in
 * `lib/ai/recipe-extraction.ts`; the staged-payload MAPPING reuses `lib/import`.
 */

/**
 * Lifecycle of one extraction attempt. `pending` is written BEFORE the provider
 * call (so even a crash leaves a trace); it flips to `succeeded` once a recipe is
 * staged, or `failed` with an `error_code` on any provider/validation error. Only
 * `succeeded` rows count toward the monthly usage cap (D4).
 */
export const AI_EXTRACTION_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type AiExtractionStatus = (typeof AI_EXTRACTION_STATUSES)[number];

/**
 * Stable, machine quality-flag codes derived (in the mapping step) from the model's
 * confidence + the unit-resolution outcome. Stored on the attempt and the staged
 * job so the preview can warn the user; localized client-side (`ai.flags.<code>`),
 * never raw model prose (CLAUDE.md: log/show metadata, not image contents).
 */
export const AI_QUALITY_FLAGS = [
  // Overall (or a specific line's) confidence fell below the warn threshold.
  'low_confidence',
  // A unit token the model read did not resolve to a known unit (→ a row issue).
  'ambiguous_unit',
  // A line whose quantity was unreadable/absent (the model returned null).
  'missing_quantity',
  // The model rated the photo legibility as poor.
  'unreadable_image',
] as const;
export type AiQualityFlag = (typeof AI_QUALITY_FLAGS)[number];
