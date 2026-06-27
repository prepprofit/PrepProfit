import { dimensionOf, toCanonical } from '@/lib/units';
import { parseRecipeUnit } from '@/lib/units/descriptor';
import { normalizeIngredientName } from '@/lib/import/resolveIngredient';
import type { DraftRecipe, DraftRecipeLine } from '@/lib/import/parse';
import type { ImportRowIssue } from '@/lib/import/types';
import type { ExtractedRecipe } from './recipe-extraction';
import {
  AI_QUALITY_FLAGS,
  type AiQualityFlag,
  type PhotoDraftIssue,
  type PhotoDraftLine,
  type PhotoExtractionDraft,
} from './types';

/**
 * The NEW photo-extraction mapping (Sprint 4.7 improvement plan, §4 / G1). Unlike the
 * legacy `mapExtractedRecipe` — which pushed an issue and then DROPPED any line it
 * could not canonicalize — this layer keeps EVERY active line the model read, marking
 * the unresolved ones `needs_review` instead of erasing them. Silent data loss is the
 * core defect the plan fixes; a chef must see "we read this, fix it" rather than a
 * confidently incomplete recipe.
 *
 * Two pure steps:
 *  - {@link mapExtractionToPhotoDraft}: validated extraction → a line-complete,
 *    editable {@link PhotoExtractionDraft} (review model; may carry unresolved fields).
 *  - {@link normalizePhotoDraftForImport}: an edited draft → the SAME `DraftRecipe[]`
 *    + `ImportRowIssue[]` the spreadsheet path feeds to `planRecipeImport`, so all the
 *    4.6 resolution/staging/confirm machinery is reused unchanged.
 *
 * No DB, no SDK — fully unit-testable from fixtures.
 */

/** Confidence at/below which a value is flagged low (mirrors the legacy threshold). */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Lower/trim/collapse key for a recipe name (mirrors the parser + planner). */
const recipeKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Map a validated extraction into a line-complete editable draft. Every ingredient
 * line becomes a {@link PhotoDraftLine}; one that cannot be canonicalized yet (null
 * quantity, a package descriptor, an unknown unit, or an unreadable name) is
 * `needs_review` with a stable issue code — never removed.
 *
 * NOTE: this consumes the CURRENT extraction shape (name/quantity/unit/confidence).
 * The prompt/schema upgrade (plan Phase 2) enriches lines with rawText, section,
 * quantityText, and package size; those fields are present on the draft type now and
 * populated as null until that slice lands.
 */
export function mapExtractionToPhotoDraft(
  extracted: ExtractedRecipe,
  meta: { attemptId: string; provider: string; model: string },
): PhotoExtractionDraft {
  const flags = new Set<AiQualityFlag>();
  if (extracted.imageQuality === 'poor') flags.add('unreadable_image');
  if (extracted.overallConfidence < LOW_CONFIDENCE_THRESHOLD) flags.add('low_confidence');

  const lines: PhotoDraftLine[] = extracted.ingredients.map((ing) => {
    if (ing.confidence < LOW_CONFIDENCE_THRESHOLD) flags.add('low_confidence');

    const issues: PhotoDraftIssue[] = [];

    // Name: kept visible even if it normalizes away (the user can retype it).
    if (normalizeIngredientName(ing.name) === '') {
      issues.push({ code: 'MISSING_NAME' });
    }

    // Unit: canonical units are fine; descriptors/unknowns keep the line for review.
    const unitResult = parseRecipeUnit(ing.unit ?? '');
    if (unitResult.kind === 'descriptor') {
      issues.push({ code: 'DESCRIPTOR_NEEDS_PACKAGE_SIZE' });
      flags.add('ambiguous_unit');
    } else if (unitResult.kind === 'unknown') {
      issues.push({ code: 'UNKNOWN_UNIT' });
      flags.add('ambiguous_unit');
    }

    // Quantity: a null (unreadable/absent) quantity blocks import but stays visible.
    if (ing.quantity === null) {
      issues.push({ code: 'MISSING_QUANTITY' });
      flags.add('missing_quantity');
    }

    return {
      id: crypto.randomUUID(),
      rawText: null,
      section: null,
      ingredientName: ing.name,
      quantityText: ing.quantity === null ? null : String(ing.quantity),
      quantityValue: ing.quantity,
      unitToken: ing.unit,
      packageSizeValue: null,
      packageSizeUnitToken: null,
      confidence: ing.confidence,
      status: issues.length === 0 ? 'ready' : 'needs_review',
      issues,
    };
  });

  return {
    attemptId: meta.attemptId,
    recipe: {
      name: extracted.name,
      yieldPortions: extracted.yieldPortions,
      preparationNotes: extracted.preparationNotes,
      lines,
    },
    qualityFlags: AI_QUALITY_FLAGS.filter((f) => flags.has(f)),
    usage: { provider: meta.provider, model: meta.model },
  };
}

/** Map a draft-line issue to the spreadsheet-import issue the preview already localizes. */
function toImportIssue(issue: PhotoDraftIssue, line: number): ImportRowIssue {
  switch (issue.code) {
    case 'MISSING_QUANTITY':
      return { line, column: 'quantity', code: 'INVALID_NUMBER' };
    case 'MISSING_NAME':
      return { line, column: 'ingredient', code: 'MISSING_REQUIRED' };
    // A descriptor without a package size or an unknown token both need a real unit.
    case 'UNKNOWN_UNIT':
    case 'DESCRIPTOR_NEEDS_PACKAGE_SIZE':
      return { line, column: 'unit', code: 'INVALID_UNIT' };
  }
}

export type NormalizedPhotoImport = {
  recipes: DraftRecipe[];
  issues: ImportRowIssue[];
};

/**
 * Convert an edited draft into the `DraftRecipe[]` + `ImportRowIssue[]` the 4.6
 * planner consumes. Only `ready` lines become importable canonical lines; `ignored`
 * lines are dropped silently (the user removed them); `needs_review` lines are
 * surfaced as row issues (so the preview still shows them) but never imported —
 * the stage endpoint blocks while any active line is `needs_review`.
 *
 * Lines are assigned synthetic 1-based ordinals purely so issues can point at
 * "line N" in the preview (a photo has no spreadsheet rows).
 */
export function normalizePhotoDraftForImport(
  draft: PhotoExtractionDraft,
): NormalizedPhotoImport {
  const issues: ImportRowIssue[] = [];
  const lines: DraftRecipeLine[] = [];

  draft.recipe.lines.forEach((line, index) => {
    const ordinal = index + 1;

    if (line.status === 'ignored') return;

    if (line.status === 'needs_review' || line.quantityValue === null) {
      const lineIssues = line.issues.length > 0 ? line.issues : [{ code: 'MISSING_QUANTITY' as const }];
      for (const issue of lineIssues) issues.push(toImportIssue(issue, ordinal));
      return;
    }

    const unitResult = parseRecipeUnit(line.unitToken ?? '');
    if (unitResult.kind !== 'canonical') {
      // Defensive: a ready line should always carry a canonical unit. If not, surface
      // it rather than silently dropping (keeps the no-loss invariant honest).
      issues.push({ line: ordinal, column: 'unit', code: 'INVALID_UNIT' });
      return;
    }

    const normalizedName = normalizeIngredientName(line.ingredientName);
    if (normalizedName === '') {
      issues.push({ line: ordinal, column: 'ingredient', code: 'MISSING_REQUIRED' });
      return;
    }

    const unit = unitResult.unit;
    const dimension = dimensionOf(unit);
    const quantityCanonical = toCanonical(line.quantityValue, unit);

    // Same ingredient twice → sum same-dimension quantities; conflicting dimensions flag.
    const existing = lines.find((l) => l.normalizedName === normalizedName);
    if (existing) {
      if (existing.dimension !== dimension) {
        issues.push({ line: ordinal, column: 'unit', code: 'UNIT_MISMATCH' });
      } else {
        existing.quantityCanonical += quantityCanonical;
      }
      return;
    }

    lines.push({ ingredientName: line.ingredientName, normalizedName, quantityCanonical, dimension });
  });

  const recipe: DraftRecipe = {
    name: draft.recipe.name,
    normalizedKey: recipeKey(draft.recipe.name),
    yieldPortions: draft.recipe.yieldPortions ?? 1,
    yieldPercentage: 100,
    firstLine: 1,
    lines,
  };

  return { recipes: [recipe], issues };
}
