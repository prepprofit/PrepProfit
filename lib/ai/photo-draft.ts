import { dimensionOf, toCanonical, type Dimension, type Unit } from '@/lib/units';
import { parseRecipeUnit } from '@/lib/units/descriptor';
import { parseQuantityText } from '@/lib/units/quantity';
import { parseUnitToken } from '@/lib/units/token';
import { normalizeIngredientName } from '@/lib/import/resolveIngredient';
import type { DraftRecipe, DraftRecipeLine } from '@/lib/import/parse';
import type { ImportRowIssue } from '@/lib/import/types';
import type { ExtractedLine, ExtractedRecipe } from './recipe-extraction';
import {
  AI_QUALITY_FLAGS,
  type AiQualityFlag,
  type PhotoDraftIssue,
  type PhotoDraftLine,
  type PhotoDraftLineStatus,
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
 * The server's TRUSTED numeric quantity (§5.4): re-parse the chef's written text
 * (fractions included) rather than trusting the model's arithmetic, falling back to
 * the model's numeric `quantity`. Null when neither yields a positive number.
 */
function resolveQuantityValue(ing: ExtractedLine): number | null {
  if (ing.quantityText != null && ing.quantityText.trim() !== '') {
    const parsed = parseQuantityText(ing.quantityText);
    if ('value' in parsed) return parsed.value;
  }
  return ing.quantity ?? null;
}

/**
 * A USABLE package size: a positive value with a CANONICAL (measurable) unit. A bare
 * number or a descriptor pack-unit is rejected (null) — a pack must measure in g/ml/…
 * to canonicalize an ingredient that is priced by weight or volume.
 */
export function canonicalPackageSize(
  value: number | null,
  unitToken: string | null,
): { value: number; unit: Unit } | null {
  if (value == null || !(value > 0)) return null;
  const token = (unitToken ?? '').trim();
  if (token === '') return null;
  const parsed = parseUnitToken(token);
  if ('error' in parsed) return null;
  return { value, unit: parsed.unit };
}

/** The line fields that decide whether a draft line can become canonical data. */
export type DraftLineResolvable = {
  ingredientName: string;
  quantityValue: number | null;
  unitToken: string | null;
  packageSizeValue: number | null;
  packageSizeUnitToken: string | null;
};

/**
 * Decide whether a (non-ignored) draft line is `ready` or `needs_review`, and why.
 * The SINGLE source of truth for resolvability — shared by `mapExtractionToPhotoDraft`,
 * the editable review UI (live status as the chef types), and the stage endpoint's
 * server-side re-check — so the three can never disagree about what is importable.
 */
export function deriveDraftLineStatus(line: DraftLineResolvable): {
  status: Exclude<PhotoDraftLineStatus, 'ignored'>;
  issues: PhotoDraftIssue[];
} {
  const issues: PhotoDraftIssue[] = [];

  if (normalizeIngredientName(line.ingredientName) === '') issues.push({ code: 'MISSING_NAME' });
  if (line.quantityValue === null) issues.push({ code: 'MISSING_QUANTITY' });

  const unitResult = parseRecipeUnit(line.unitToken ?? '');
  if (unitResult.kind === 'descriptor') {
    if (!canonicalPackageSize(line.packageSizeValue, line.packageSizeUnitToken)) {
      issues.push({ code: 'DESCRIPTOR_NEEDS_PACKAGE_SIZE' });
    }
  } else if (unitResult.kind === 'unknown') {
    issues.push({ code: 'UNKNOWN_UNIT' });
  }

  return { status: issues.length === 0 ? 'ready' : 'needs_review', issues };
}

/** Map a draft-line issue to the coarse quality flag the preview warns on. */
function flagForIssue(code: PhotoDraftIssue['code']): AiQualityFlag | null {
  switch (code) {
    case 'MISSING_QUANTITY':
      return 'missing_quantity';
    case 'UNKNOWN_UNIT':
    case 'DESCRIPTOR_NEEDS_PACKAGE_SIZE':
      return 'ambiguous_unit';
    case 'MISSING_NAME':
      return null;
  }
}

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
    const crossedOut = ing.crossedOut === true;
    const quantityValue = resolveQuantityValue(ing);

    // A crossed-out line is returned (so the UI can show why) but never validated or
    // imported — it starts `ignored` and carries no issues/flags.
    const resolvable: DraftLineResolvable = {
      ingredientName: ing.name,
      quantityValue,
      unitToken: ing.unit,
      packageSizeValue: ing.packageSizeValue ?? null,
      packageSizeUnitToken: ing.packageSizeUnit ?? null,
    };
    const { status, issues } = crossedOut
      ? { status: 'ignored' as PhotoDraftLineStatus, issues: [] as PhotoDraftIssue[] }
      : deriveDraftLineStatus(resolvable);

    if (!crossedOut) {
      if (ing.confidence < LOW_CONFIDENCE_THRESHOLD) flags.add('low_confidence');
      for (const issue of issues) {
        const flag = flagForIssue(issue.code);
        if (flag) flags.add(flag);
      }
    }

    return {
      id: crypto.randomUUID(),
      rawText: ing.rawText ?? null,
      section: ing.section ?? null,
      ingredientName: ing.name,
      // Prefer the chef's written text; fall back to the trusted numeric for display.
      quantityText: ing.quantityText ?? (quantityValue === null ? null : String(quantityValue)),
      quantityValue,
      unitToken: ing.unit,
      packageSizeValue: ing.packageSizeValue ?? null,
      packageSizeUnitToken: ing.packageSizeUnit ?? null,
      confidence: ing.confidence,
      status,
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
 * The canonical (g/ml/count) quantity + dimension for a READY line: a true unit
 * converts directly; a package descriptor canonicalizes from its pack size
 * (`2 pkt × 300 g = 600 g`). Null when the line cannot be canonicalized (a ready
 * line should never hit this — it is a defensive guard for the no-loss invariant).
 */
function canonicalForLine(
  line: PhotoDraftLine,
): { quantityCanonical: number; dimension: Dimension } | null {
  if (line.quantityValue === null) return null;
  const unitResult = parseRecipeUnit(line.unitToken ?? '');
  if (unitResult.kind === 'canonical') {
    return {
      quantityCanonical: toCanonical(line.quantityValue, unitResult.unit),
      dimension: dimensionOf(unitResult.unit),
    };
  }
  if (unitResult.kind === 'descriptor') {
    const pack = canonicalPackageSize(line.packageSizeValue, line.packageSizeUnitToken);
    if (!pack) return null;
    return {
      quantityCanonical: line.quantityValue * toCanonical(pack.value, pack.unit),
      dimension: dimensionOf(pack.unit),
    };
  }
  return null;
}

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

    const canonical = canonicalForLine(line);
    if (!canonical) {
      // Defensive: a ready line should always canonicalize. If not, surface it rather
      // than silently dropping (keeps the no-loss invariant honest).
      issues.push({ line: ordinal, column: 'unit', code: 'INVALID_UNIT' });
      return;
    }

    const normalizedName = normalizeIngredientName(line.ingredientName);
    if (normalizedName === '') {
      issues.push({ line: ordinal, column: 'ingredient', code: 'MISSING_REQUIRED' });
      return;
    }

    // Same ingredient twice → sum same-dimension quantities; conflicting dimensions flag.
    const existing = lines.find((l) => l.normalizedName === normalizedName);
    if (existing) {
      if (existing.dimension !== canonical.dimension) {
        issues.push({ line: ordinal, column: 'unit', code: 'UNIT_MISMATCH' });
      } else {
        existing.quantityCanonical += canonical.quantityCanonical;
      }
      return;
    }

    lines.push({
      ingredientName: line.ingredientName,
      normalizedName,
      quantityCanonical: canonical.quantityCanonical,
      dimension: canonical.dimension,
    });
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
