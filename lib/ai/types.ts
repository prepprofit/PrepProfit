/**
 * Dependency-free shared types for AI photo recipe extraction (Sprint 4.7).
 *
 * Like `lib/import/types.ts`, this module is intentionally IMPORT-FREE (no Drizzle
 * schema, no SDK, no zod) so it can be imported by `lib/db/schema.ts` for the
 * `ai_extraction_attempts` column `$type`s without dragging the Gemini SDK into the
 * schema / migration tooling. The SDK-coupled extractor + Zod validation live in
 * `lib/ai/recipe-extraction.ts`; the staged-payload MAPPING reuses `lib/import`.
 *
 * The type-only import below is erased at runtime, so this stays dependency-free.
 */
import type { ImportRecipePayload, ImportRowIssue } from '@/lib/import/types';

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

/**
 * The success body of the photo-extraction route: a staged `recipe_photo` job the
 * client reviews (the SAME `ImportRecipePayload` + issues the 4.6 panel renders),
 * plus the derived quality flags to warn on. Confirm reuses `confirmImportAction`
 * with `{ jobId, resolutions }`.
 */
export type PhotoExtractionPreview = {
  jobId: string;
  counts: { total: number; importable: number; skipped: number; invalid: number };
  issues: ImportRowIssue[];
  recipePayload: ImportRecipePayload;
  qualityFlags: AiQualityFlag[];
};

/* -------------------------------------------------------------------------- */
/* Editable photo draft (Sprint 4.7 improvement plan)                         */
/* -------------------------------------------------------------------------- */

/**
 * Per-line review state in the editable photo draft (§4.1). The core of G1 (no
 * silent data loss): a line the model read but that cannot yet be canonical is
 * `needs_review`, NEVER deleted. `ignored` is a crossed-out or user-removed line,
 * kept (restorable) until staging. Staging is blocked while any active line is
 * `needs_review`.
 */
export const PHOTO_DRAFT_LINE_STATUSES = ['ready', 'needs_review', 'ignored'] as const;
export type PhotoDraftLineStatus = (typeof PHOTO_DRAFT_LINE_STATUSES)[number];

/**
 * Why a draft line is `needs_review` (or, for `MISSING_NAME`, otherwise flawed).
 * Stable codes localized client-side (`ai.draftIssues.<code>`) — never raw model
 * prose. A `ready` line carries none.
 */
export const PHOTO_DRAFT_ISSUE_CODES = [
  // The model read no usable quantity, or it could not be parsed to a number.
  'MISSING_QUANTITY',
  // A unit token that resolved to neither a canonical unit nor a known descriptor.
  'UNKNOWN_UNIT',
  // A package descriptor (pkt/block/…) with no package size yet — cannot canonicalize.
  'DESCRIPTOR_NEEDS_PACKAGE_SIZE',
  // The ingredient name was blank/unreadable; the user must supply it.
  'MISSING_NAME',
] as const;
export type PhotoDraftIssueCode = (typeof PHOTO_DRAFT_ISSUE_CODES)[number];

export type PhotoDraftIssue = { code: PhotoDraftIssueCode };

/**
 * One editable ingredient line as READ from the photo (§4.1). Carries both the
 * chef's original entry (`quantityText`, `unitToken`, `section`) for trustworthy
 * review display AND the parsed numeric form. `rawText` is review-only and must
 * never be logged. `id` is a client-stable line id (server-generated).
 */
export type PhotoDraftLine = {
  id: string;
  /** The full source line as transcribed — review display only, never logged/audited. */
  rawText: string | null;
  /** Section label (`Syrup`, `Filling`, …) for review grouping; flattened at storage. */
  section: string | null;
  ingredientName: string;
  /** The quantity exactly as written (`1/2`, `1 1/2`, `½`) — display + re-parse source. */
  quantityText: string | null;
  /** The parsed numeric quantity, or null when absent/unparseable. */
  quantityValue: number | null;
  /** The raw unit/descriptor token as written (`cup`, `tbsp`, `pkt`), or null. */
  unitToken: string | null;
  /** A parenthetical package size value (`1 pkt walnuts (300g)` → 300), or null. */
  packageSizeValue: number | null;
  packageSizeUnitToken: string | null;
  /** The model's per-line certainty in [0, 1]. */
  confidence: number;
  status: PhotoDraftLineStatus;
  issues: PhotoDraftIssue[];
};

/**
 * The editable draft returned by photo extraction BEFORE any import job exists
 * (§4.1). Line-complete (every active line the model read is present) and may carry
 * unresolved fields the user fixes in the review workbench; the server converts it
 * to an `ImportRecipePayload` only at the separate stage step. `usage` is provider
 * metadata only (no tokens/cost here — those stay on the attempt row).
 */
export type PhotoExtractionDraft = {
  /** Org-scoped extraction attempt id, re-validated server-side on every follow-up. */
  attemptId: string;
  recipe: {
    name: string;
    yieldPortions: number | null;
    preparationNotes: string | null;
    lines: PhotoDraftLine[];
  };
  qualityFlags: AiQualityFlag[];
  usage: { provider: string; model: string };
};
