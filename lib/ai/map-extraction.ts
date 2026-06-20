import { dimensionOf, toCanonical } from '@/lib/units';
import { parseUnitToken } from '@/lib/units/token';
import { normalizeIngredientName } from '@/lib/import/resolveIngredient';
import type { DraftRecipe, DraftRecipeLine } from '@/lib/import/parse';
import type { ImportRowIssue } from '@/lib/import/types';
import type { ExtractedRecipe } from './recipe-extraction';
import { AI_QUALITY_FLAGS, type AiQualityFlag } from './types';

/**
 * PURE mapping (Sprint 4.7 step 3): a validated {@link ExtractedRecipe} → the SAME
 * `DraftRecipe[]` shape the spreadsheet parser produces, plus per-line issues and
 * derived quality flags. No DB, no SDK — fully unit-testable from fixtures.
 *
 * The point is MAXIMUM REUSE: the output feeds `planRecipeImport` (lib/data/import)
 * unchanged, so ingredient NAME→id resolution (exact / fuzzy-suggestion / new,
 * never an auto-link), org duplicate-recipe detection, new-ingredient staging
 * (priceCents 0 + needs_pricing), and the staged `ImportRecipePayload` + confirm
 * are all the existing 4.6 machinery. This module only does the AI-specific part:
 * normalize units (unknown/ambiguous ⇒ a row issue, NEVER a guess), drop lines the
 * model could not read, and translate confidence/image-quality into stable flags.
 *
 * v1 is ONE recipe per photo (D3); the structure already returns an array so a
 * future multi-recipe extraction needs no shape change.
 */

/**
 * Confidence at/below which a value is treated as low (flagged in the preview, never
 * silently trusted). Per-line OR overall confidence under this raises `low_confidence`.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export type MappedExtraction = {
  /** Draft recipes ready for `planRecipeImport` (one in v1). */
  recipes: DraftRecipe[];
  /** Per-line issues (stable codes, localized client-side) — same shape as the parser. */
  issues: ImportRowIssue[];
  /** Derived, de-duplicated quality flags (canonical order) for preview + the attempt. */
  qualityFlags: AiQualityFlag[];
};

/** Lower/trim/collapse key for a recipe name (mirrors the parser + planner). */
const recipeKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Map a validated extraction into draft recipe(s) + issues + flags. Ingredient
 * lines are assigned synthetic 1-based ordinals (a photo has no spreadsheet rows)
 * purely so issues can point at "line N" in the preview.
 */
export function mapExtractedRecipe(extracted: ExtractedRecipe): MappedExtraction {
  const issues: ImportRowIssue[] = [];
  const flags = new Set<AiQualityFlag>();

  if (extracted.imageQuality === 'poor') flags.add('unreadable_image');
  if (extracted.overallConfidence < LOW_CONFIDENCE_THRESHOLD) flags.add('low_confidence');

  const lines: DraftRecipeLine[] = [];

  extracted.ingredients.forEach((ing, index) => {
    const line = index + 1; // 1-based ordinal for preview messages

    if (ing.confidence < LOW_CONFIDENCE_THRESHOLD) flags.add('low_confidence');

    // The model returns null for an unreadable/absent quantity — never a guess, so
    // the line cannot be imported. Flag it and skip (mirrors the parser dropping a
    // blank/invalid quantity cell).
    if (ing.quantity === null) {
      issues.push({ line, column: 'quantity', code: 'INVALID_NUMBER' });
      flags.add('missing_quantity');
      return;
    }

    const normalizedName = normalizeIngredientName(ing.name);
    if (normalizedName === '') {
      // A name that normalizes away (e.g. pure punctuation the model misread).
      issues.push({ line, column: 'ingredient', code: 'MISSING_REQUIRED' });
      return;
    }

    // A null unit means "no unit shown" (e.g. "6 eggs") → count, exactly like a
    // blank spreadsheet cell. An UNKNOWN token is ambiguous → a row issue, not a guess.
    const parsedUnit = parseUnitToken(ing.unit ?? '');
    if ('error' in parsedUnit) {
      issues.push({ line, column: 'unit', code: parsedUnit.error });
      flags.add('ambiguous_unit');
      return;
    }

    const unit = parsedUnit.unit;
    const dimension = dimensionOf(unit);
    const quantityCanonical = toCanonical(ing.quantity, unit);

    // Same ingredient twice in one recipe → sum canonical quantities, unless the two
    // lines use incompatible dimensions (g then ml) → flag, don't merge (mirrors parser).
    const existing = lines.find((l) => l.normalizedName === normalizedName);
    if (existing) {
      if (existing.dimension !== dimension) {
        issues.push({ line, column: 'unit', code: 'UNIT_MISMATCH' });
        flags.add('ambiguous_unit');
      } else {
        existing.quantityCanonical += quantityCanonical;
      }
      return;
    }

    lines.push({ ingredientName: ing.name, normalizedName, quantityCanonical, dimension });
  });

  const recipe: DraftRecipe = {
    name: extracted.name,
    normalizedKey: recipeKey(extracted.name),
    // A photo rarely states a loss percentage; default to 100% (no loss), as the
    // spreadsheet parser does for a blank cell. Yield portions default to 1.
    yieldPortions: extracted.yieldPortions ?? 1,
    yieldPercentage: 100,
    firstLine: 1,
    lines,
  };

  // Emit flags in the canonical AI_QUALITY_FLAGS order for stable storage.
  const qualityFlags = AI_QUALITY_FLAGS.filter((f) => flags.has(f));
  return { recipes: [recipe], issues, qualityFlags };
}
