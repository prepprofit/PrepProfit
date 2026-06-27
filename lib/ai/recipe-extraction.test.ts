import { describe, it, expect } from 'vitest';
import {
  parseExtractionResponse,
  RecipeExtractionError,
  RECIPE_EXTRACTION_MODEL,
  RECIPE_EXTRACTION_PROVIDER,
  type ExtractedRecipe,
} from './recipe-extraction';

/**
 * Provider-boundary tests (Sprint 4.7 step 1). The Gemini SDK is NEVER called here
 * (CLAUDE.md: provider always mocked) — these exercise only the untrusted-input
 * boundary, `parseExtractionResponse`, against fixed raw-response fixtures. The
 * richer extraction → payload mapping (ambiguous units, hallucinated/duplicate
 * ingredients) is tested separately in the pure mapping step.
 */

/** A well-formed model response (the JSON string the model would return). */
const goodResponse: ExtractedRecipe = {
  name: 'Pão de Ló',
  yieldPortions: 8,
  ingredients: [
    { name: 'Farinha', quantity: 250, unit: 'g', confidence: 0.98 },
    { name: 'Açúcar', quantity: 200, unit: 'g', confidence: 0.95 },
    { name: 'Ovos', quantity: 6, unit: null, confidence: 0.9 },
  ],
  preparationNotes: 'Bater os ovos com o açúcar; juntar a farinha.',
  overallConfidence: 0.94,
  imageQuality: 'good',
};

const json = (value: unknown): string => JSON.stringify(value);

describe('parseExtractionResponse — happy path', () => {
  it('parses a well-formed response into a strict ExtractedRecipe', () => {
    const result = parseExtractionResponse(json(goodResponse));
    expect(result.name).toBe('Pão de Ló');
    expect(result.yieldPortions).toBe(8);
    expect(result.ingredients).toHaveLength(3);
    expect(result.ingredients[0]).toEqual({
      name: 'Farinha',
      quantity: 250,
      unit: 'g',
      confidence: 0.98,
    });
  });

  it('tolerates null quantity / unit (unreadable or absent values, never guessed)', () => {
    const result = parseExtractionResponse(
      json({
        ...goodResponse,
        ingredients: [{ name: 'Sal', quantity: null, unit: null, confidence: 0.4 }],
      }),
    );
    const line = result.ingredients[0];
    expect(line).toBeDefined();
    expect(line?.quantity).toBeNull();
    expect(line?.unit).toBeNull();
  });

  it('tolerates null yieldPortions and null preparationNotes', () => {
    const result = parseExtractionResponse(
      json({ ...goodResponse, yieldPortions: null, preparationNotes: null }),
    );
    expect(result.yieldPortions).toBeNull();
    expect(result.preparationNotes).toBeNull();
  });

  it('accepts low confidence and poor image quality as valid data (flagged later, never rejected)', () => {
    const result = parseExtractionResponse(
      json({ ...goodResponse, overallConfidence: 0.05, imageQuality: 'poor' }),
    );
    expect(result.overallConfidence).toBe(0.05);
    expect(result.imageQuality).toBe('poor');
  });

  it('accepts an empty ingredient list (the mapping step decides importability)', () => {
    const result = parseExtractionResponse(json({ ...goodResponse, ingredients: [] }));
    expect(result.ingredients).toEqual([]);
  });

  it('strips unknown extra fields the model may add', () => {
    const result = parseExtractionResponse(
      json({ ...goodResponse, hallucinatedField: 'ignore me', cost: 9.99 }),
    );
    expect(result).not.toHaveProperty('hallucinatedField');
    expect(result).not.toHaveProperty('cost');
  });
});

describe('parseExtractionResponse — Phase 2 rich line fields', () => {
  it('parses and preserves rawText, section, quantityText, pack size, and crossedOut', () => {
    const result = parseExtractionResponse(
      json({
        ...goodResponse,
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
        ],
      }),
    );
    expect(result.ingredients[0]).toMatchObject({
      rawText: '1 pkt walnuts (300g)',
      section: 'Filling',
      quantityText: '1',
      packageSizeValue: 300,
      packageSizeUnit: 'g',
      crossedOut: false,
    });
  });

  it('rejects a non-positive package size (untrusted-input boundary)', () => {
    expect(() =>
      parseExtractionResponse(
        json({
          ...goodResponse,
          ingredients: [
            { name: 'Walnuts', quantity: 1, unit: 'pkt', packageSizeValue: -5, confidence: 0.9 },
          ],
        }),
      ),
    ).toThrow(RecipeExtractionError);
  });
});

describe('parseExtractionResponse — rejects malformed output', () => {
  it('throws on non-JSON output', () => {
    expect(() => parseExtractionResponse('not json at all')).toThrow(RecipeExtractionError);
    expect(() => parseExtractionResponse('')).toThrow(RecipeExtractionError);
  });

  it('throws when a required field is missing', () => {
    const withoutName: Partial<ExtractedRecipe> = { ...goodResponse };
    delete withoutName.name;
    expect(() => parseExtractionResponse(json(withoutName))).toThrow(RecipeExtractionError);
  });

  it('throws on an out-of-range confidence', () => {
    expect(() =>
      parseExtractionResponse(json({ ...goodResponse, overallConfidence: 1.5 })),
    ).toThrow(RecipeExtractionError);
    expect(() =>
      parseExtractionResponse(
        json({
          ...goodResponse,
          ingredients: [{ name: 'Sal', quantity: 1, unit: 'g', confidence: -0.1 }],
        }),
      ),
    ).toThrow(RecipeExtractionError);
  });

  it('throws on a non-positive or non-finite quantity (no zero/negative/Infinity lines)', () => {
    for (const quantity of [0, -5]) {
      expect(() =>
        parseExtractionResponse(
          json({
            ...goodResponse,
            ingredients: [{ name: 'Sal', quantity, unit: 'g', confidence: 0.9 }],
          }),
        ),
      ).toThrow(RecipeExtractionError);
    }
    // Infinity is not representable in JSON; a string sneaking in must also reject.
    expect(() =>
      parseExtractionResponse(
        json({
          ...goodResponse,
          ingredients: [{ name: 'Sal', quantity: '250', unit: 'g', confidence: 0.9 }],
        }),
      ),
    ).toThrow(RecipeExtractionError);
  });

  it('throws on an unknown imageQuality enum value', () => {
    expect(() =>
      parseExtractionResponse(json({ ...goodResponse, imageQuality: 'blurry' })),
    ).toThrow(RecipeExtractionError);
  });

  it('throws when the ingredient list exceeds the hard cap (anti-balloon)', () => {
    const tooMany = Array.from({ length: 201 }, (_v, i) => ({
      name: `Ingredient ${i}`,
      quantity: 1,
      unit: 'g',
      confidence: 0.9,
    }));
    expect(() =>
      parseExtractionResponse(json({ ...goodResponse, ingredients: tooMany })),
    ).toThrow(RecipeExtractionError);
  });

  it('throws on a blank ingredient name', () => {
    expect(() =>
      parseExtractionResponse(
        json({
          ...goodResponse,
          ingredients: [{ name: '   ', quantity: 1, unit: 'g', confidence: 0.9 }],
        }),
      ),
    ).toThrow(RecipeExtractionError);
  });
});

describe('pinned model config (D1/Q3 — guard against an accidental swap)', () => {
  it('uses the stable Gemini 3.5 Flash id from the single source of truth', () => {
    expect(RECIPE_EXTRACTION_MODEL).toBe('gemini-3.5-flash');
    expect(RECIPE_EXTRACTION_PROVIDER).toBe('google');
  });
});
