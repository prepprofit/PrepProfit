import { describe, it, expect } from 'vitest';
import { mapExtractedRecipe, LOW_CONFIDENCE_THRESHOLD } from './map-extraction';
import type { ExtractedRecipe } from './recipe-extraction';

/**
 * Pure mapping tests (Sprint 4.7 step 3). The provider is never involved — these
 * feed fixed, already-validated `ExtractedRecipe` fixtures (good / blurry / ambiguous
 * unit / hallucinated / duplicate / low-confidence) and assert the draft recipe,
 * row issues, and quality flags. Unit normalization and the "never guess" rule are
 * the focus; ingredient resolution + new-ingredient staging are `planRecipeImport`'s
 * job (covered by the 4.6 + step-2 suites), not this layer.
 */

const base: ExtractedRecipe = {
  name: 'Chocolate Cake',
  yieldPortions: 8,
  ingredients: [
    { name: 'Flour', quantity: 0.5, unit: 'kg', confidence: 0.97 },
    { name: 'Eggs', quantity: 6, unit: null, confidence: 0.95 },
    { name: 'Milk', quantity: 2, unit: 'cups', confidence: 0.9 },
  ],
  preparationNotes: 'Mix and bake.',
  overallConfidence: 0.95,
  imageQuality: 'good',
};

describe('mapExtractedRecipe — good photo', () => {
  it('maps one recipe with canonical quantities and no issues/flags', () => {
    const { recipes, issues, qualityFlags } = mapExtractedRecipe(base);
    expect(recipes).toHaveLength(1);
    const recipe = recipes[0]!;
    expect(recipe.name).toBe('Chocolate Cake');
    expect(recipe.normalizedKey).toBe('chocolate cake');
    expect(recipe.yieldPortions).toBe(8);
    expect(recipe.yieldPercentage).toBe(100);
    expect(issues).toEqual([]);
    expect(qualityFlags).toEqual([]);
  });

  it('normalizes units to canonical amounts (kg→g, cups→ml, null→count)', () => {
    const { recipes } = mapExtractedRecipe(base);
    const lines = recipes[0]!.lines;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ normalizedName: 'flour', dimension: 'weight', quantityCanonical: 500 });
    // null unit → count (bare number), like a blank spreadsheet cell.
    expect(lines[1]).toMatchObject({ normalizedName: 'eggs', dimension: 'count', quantityCanonical: 6 });
    // "cups" alias → cup → 2 * 236.5882365 ml.
    expect(lines[2]!.dimension).toBe('volume');
    expect(lines[2]!.quantityCanonical).toBeCloseTo(473.176, 2);
  });

  it('defaults a missing yield to 1 portion', () => {
    const { recipes } = mapExtractedRecipe({ ...base, yieldPortions: null });
    expect(recipes[0]!.yieldPortions).toBe(1);
  });
});

describe('mapExtractedRecipe — ambiguous / unreadable values never become data', () => {
  it('flags an unknown unit as a row issue and drops the line (no guess)', () => {
    const { recipes, issues, qualityFlags } = mapExtractedRecipe({
      ...base,
      ingredients: [{ name: 'Butter', quantity: 2, unit: 'tablespoons', confidence: 0.9 }],
    });
    expect(recipes[0]!.lines).toHaveLength(0);
    expect(issues).toEqual([{ line: 1, column: 'unit', code: 'INVALID_UNIT' }]);
    expect(qualityFlags).toContain('ambiguous_unit');
  });

  it('flags a null (unreadable) quantity and drops the line', () => {
    const { recipes, issues, qualityFlags } = mapExtractedRecipe({
      ...base,
      ingredients: [{ name: 'Salt', quantity: null, unit: 'g', confidence: 0.8 }],
    });
    expect(recipes[0]!.lines).toHaveLength(0);
    expect(issues).toEqual([{ line: 1, column: 'quantity', code: 'INVALID_NUMBER' }]);
    expect(qualityFlags).toContain('missing_quantity');
  });

  it('drops a hallucinated name that normalizes to nothing', () => {
    const { recipes, issues } = mapExtractedRecipe({
      ...base,
      ingredients: [{ name: '— —', quantity: 1, unit: 'g', confidence: 0.9 }],
    });
    expect(recipes[0]!.lines).toHaveLength(0);
    expect(issues).toEqual([{ line: 1, column: 'ingredient', code: 'MISSING_REQUIRED' }]);
  });
});

describe('mapExtractedRecipe — duplicate ingredient lines', () => {
  it('sums two same-dimension lines for one ingredient', () => {
    const { recipes, issues } = mapExtractedRecipe({
      ...base,
      ingredients: [
        { name: 'Sugar', quantity: 100, unit: 'g', confidence: 0.95 },
        { name: 'sugar', quantity: 50, unit: 'g', confidence: 0.95 },
      ],
    });
    const lines = recipes[0]!.lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ normalizedName: 'sugar', quantityCanonical: 150 });
    expect(issues).toEqual([]);
  });

  it('flags a conflicting-dimension duplicate instead of merging', () => {
    const { recipes, issues, qualityFlags } = mapExtractedRecipe({
      ...base,
      ingredients: [
        { name: 'Cream', quantity: 100, unit: 'g', confidence: 0.95 },
        { name: 'Cream', quantity: 100, unit: 'ml', confidence: 0.95 },
      ],
    });
    expect(recipes[0]!.lines).toHaveLength(1); // the first (weight) line stands
    expect(issues).toEqual([{ line: 2, column: 'unit', code: 'UNIT_MISMATCH' }]);
    expect(qualityFlags).toContain('ambiguous_unit');
  });
});

describe('mapExtractedRecipe — confidence + image-quality flags', () => {
  it('raises low_confidence when the overall confidence is below the threshold', () => {
    const { qualityFlags } = mapExtractedRecipe({
      ...base,
      overallConfidence: LOW_CONFIDENCE_THRESHOLD - 0.1,
    });
    expect(qualityFlags).toContain('low_confidence');
  });

  it('raises low_confidence when any single line is below the threshold', () => {
    const { qualityFlags } = mapExtractedRecipe({
      ...base,
      ingredients: [{ name: 'Vanilla', quantity: 1, unit: 'count', confidence: 0.2 }],
    });
    expect(qualityFlags).toContain('low_confidence');
  });

  it('raises unreadable_image for a poor-quality photo', () => {
    const { qualityFlags } = mapExtractedRecipe({ ...base, imageQuality: 'poor' });
    expect(qualityFlags).toContain('unreadable_image');
  });

  it('de-duplicates flags and emits them in canonical order', () => {
    const { qualityFlags } = mapExtractedRecipe({
      ...base,
      overallConfidence: 0.1,
      imageQuality: 'poor',
      ingredients: [
        { name: 'X', quantity: null, unit: 'g', confidence: 0.1 },
        { name: 'Y', quantity: 1, unit: 'smidgen', confidence: 0.1 },
      ],
    });
    // Canonical order: low_confidence, ambiguous_unit, missing_quantity, unreadable_image.
    expect(qualityFlags).toEqual([
      'low_confidence',
      'ambiguous_unit',
      'missing_quantity',
      'unreadable_image',
    ]);
  });
});
