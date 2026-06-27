import { describe, expect, it } from 'vitest';
import {
  mapExtractionToPhotoDraft,
  normalizePhotoDraftForImport,
} from './photo-draft';
import type { ExtractedRecipe } from './recipe-extraction';
import type { PhotoDraftIssueCode, PhotoExtractionDraft } from './types';

const META = { attemptId: 'att_1', provider: 'google', model: 'gemini-test' };

const draftOf = (extracted: ExtractedRecipe): PhotoExtractionDraft =>
  mapExtractionToPhotoDraft(extracted, META);

/** A minimal extraction wrapping just the ingredient lines under test. */
const recipe = (ingredients: ExtractedRecipe['ingredients']): ExtractedRecipe => ({
  name: 'Test',
  yieldPortions: null,
  ingredients,
  preparationNotes: null,
  overallConfidence: 0.9,
  imageQuality: 'good',
});

/** Codes attached to the line whose ingredient name matches. */
const codesFor = (draft: PhotoExtractionDraft, name: string): PhotoDraftIssueCode[] => {
  const line = draft.recipe.lines.find((l) => l.ingredientName === name);
  if (!line) throw new Error(`line not found: ${name}`);
  return line.issues.map((i) => i.code);
};

/* -------------------------------------------------------------------------- */
/* G1 — no active line the model read is ever dropped                          */
/* -------------------------------------------------------------------------- */

describe('mapExtractionToPhotoDraft — keeps every line (no silent loss)', () => {
  const base: ExtractedRecipe = {
    name: 'Mixed',
    yieldPortions: 4,
    ingredients: [
      { name: 'Flour', quantity: 0.5, unit: 'kg', confidence: 0.97 },
      { name: 'Salt', quantity: null, unit: 'g', confidence: 0.8 }, // unreadable qty
      { name: 'Butter', quantity: 1, unit: 'block', confidence: 0.9 }, // descriptor
      { name: 'Mystery', quantity: 1, unit: 'zorp', confidence: 0.9 }, // unknown unit
    ],
    preparationNotes: null,
    overallConfidence: 0.9,
    imageQuality: 'good',
  };

  it('returns one draft line per extracted ingredient — none removed', () => {
    const draft = draftOf(base);
    expect(draft.recipe.lines).toHaveLength(4);
    expect(draft.recipe.lines.map((l) => l.ingredientName)).toEqual([
      'Flour',
      'Salt',
      'Butter',
      'Mystery',
    ]);
  });

  it('marks an unreadable quantity needs_review (was silently dropped before)', () => {
    const draft = draftOf(base);
    const salt = draft.recipe.lines[1]!;
    expect(salt.status).toBe('needs_review');
    expect(salt.quantityValue).toBeNull();
    expect(codesFor(draft, 'Salt')).toContain('MISSING_QUANTITY');
    expect(draft.qualityFlags).toContain('missing_quantity');
  });

  it('marks a package descriptor needs_review, preserving the token', () => {
    const draft = draftOf(base);
    const butter = draft.recipe.lines[2]!;
    expect(butter.status).toBe('needs_review');
    expect(butter.unitToken).toBe('block');
    expect(codesFor(draft, 'Butter')).toContain('DESCRIPTOR_NEEDS_PACKAGE_SIZE');
  });

  it('marks an unknown unit needs_review instead of dropping the line', () => {
    const draft = draftOf(base);
    expect(draft.recipe.lines[3]!.status).toBe('needs_review');
    expect(codesFor(draft, 'Mystery')).toContain('UNKNOWN_UNIT');
    expect(draft.qualityFlags).toContain('ambiguous_unit');
  });

  it('keeps a name that normalizes away as needs_review (user can retype)', () => {
    const draft = draftOf({
      ...base,
      ingredients: [{ name: '— —', quantity: 1, unit: 'g', confidence: 0.9 }],
    });
    expect(draft.recipe.lines).toHaveLength(1);
    expect(draft.recipe.lines[0]!.status).toBe('needs_review');
    expect(draft.recipe.lines[0]!.issues.map((i) => i.code)).toContain('MISSING_NAME');
  });

  it('marks a clean canonical line ready (tsp/tbsp included)', () => {
    const draft = draftOf({
      ...base,
      ingredients: [
        { name: 'Honey', quantity: 3, unit: 'tbsp', confidence: 0.95 },
        { name: 'Cinnamon', quantity: 2, unit: 'tsp', confidence: 0.95 },
      ],
    });
    expect(draft.recipe.lines.every((l) => l.status === 'ready')).toBe(true);
    expect(draft.qualityFlags).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Phase 2 — rich extraction fields (sections, fractions, pack size, crossed)  */
/* -------------------------------------------------------------------------- */

describe('mapExtractionToPhotoDraft — Phase 2 rich fields', () => {
  it('re-parses the written quantity text, ignoring a wrong model numeric (§5.4)', () => {
    const draft = draftOf(
      recipe([{ name: 'Honey', quantityText: '½', quantity: 9, unit: 'cup', confidence: 0.9 }]),
    );
    const line = draft.recipe.lines[0]!;
    // The server trusts the chef's text (0.5), never the model's arithmetic (9).
    expect(line.quantityValue).toBe(0.5);
    expect(line.quantityText).toBe('½');
    expect(line.status).toBe('ready');
  });

  it('keeps a line whose written text is unparseable as needs_review (no guess)', () => {
    const draft = draftOf(
      recipe([{ name: 'Salt', quantityText: 'to taste', quantity: null, unit: 'g', confidence: 0.6 }]),
    );
    const line = draft.recipe.lines[0]!;
    expect(line.quantityValue).toBeNull();
    expect(line.status).toBe('needs_review');
    expect(line.issues.map((i) => i.code)).toContain('MISSING_QUANTITY');
  });

  it('makes a descriptor WITH a pack size ready and canonicalizes from the pack (§5.2)', () => {
    const draft = draftOf(
      recipe([
        {
          name: 'Walnuts',
          quantity: 2,
          unit: 'pkt',
          packageSizeValue: 300,
          packageSizeUnit: 'g',
          confidence: 0.9,
        },
      ]),
    );
    expect(draft.recipe.lines[0]!.status).toBe('ready');
    const { recipes } = normalizePhotoDraftForImport(draft);
    const line = recipes[0]!.lines[0]!;
    expect(line.dimension).toBe('weight');
    expect(line.quantityCanonical).toBe(600); // 2 pkt × 300 g
  });

  it('keeps a descriptor WITHOUT a usable pack size as needs_review', () => {
    const draft = draftOf(
      recipe([
        // A bare number as the pack unit is not a measurable pack → still needs review.
        { name: 'Walnuts', quantity: 1, unit: 'pkt', packageSizeValue: 300, packageSizeUnit: null, confidence: 0.9 },
      ]),
    );
    expect(draft.recipe.lines[0]!.status).toBe('needs_review');
    expect(draft.recipe.lines[0]!.issues.map((i) => i.code)).toContain(
      'DESCRIPTOR_NEEDS_PACKAGE_SIZE',
    );
  });

  it('treats a crossed-out line as ignored: no issues, never imported', () => {
    const draft = draftOf(
      recipe([
        { name: 'Brandy', quantity: 2, unit: 'tbsp', crossedOut: true, confidence: 0.7 },
        { name: 'Honey', quantity: 3, unit: 'tbsp', crossedOut: false, confidence: 0.9 },
      ]),
    );
    const brandy = draft.recipe.lines[0]!;
    expect(brandy.status).toBe('ignored');
    expect(brandy.issues).toEqual([]);

    const { recipes, issues } = normalizePhotoDraftForImport(draft);
    expect(recipes[0]!.lines.map((l) => l.normalizedName)).toEqual(['honey']);
    expect(issues).toEqual([]); // an ignored line is never surfaced as an issue
  });

  it('preserves section, rawText, and unit token on the draft line', () => {
    const draft = draftOf(
      recipe([
        {
          rawText: '200 ml water',
          section: 'Syrup',
          name: 'Water',
          quantity: 200,
          unit: 'ml',
          confidence: 0.95,
        },
      ]),
    );
    const line = draft.recipe.lines[0]!;
    expect(line.section).toBe('Syrup');
    expect(line.rawText).toBe('200 ml water');
    expect(line.unitToken).toBe('ml');
  });
});

/* -------------------------------------------------------------------------- */
/* Baklava regression — the plan's mandatory fixture (current extraction shape) */
/* -------------------------------------------------------------------------- */

/**
 * The 11 active Baklava lines as the CURRENT model plausibly reads them. Sections and
 * the crossed-out line need the prompt/schema upgrade (Phase 2); this fixture proves
 * the Phase-1 invariant: every active line is visible (ready or needs_review), the
 * tsp/tbsp lines parse, and nothing is silently lost.
 */
const baklava: ExtractedRecipe = {
  name: 'Baklava',
  yieldPortions: 24,
  ingredients: [
    { name: 'Phyllo pastry', quantity: 1, unit: 'pkt', confidence: 0.9 },
    { name: 'Unsalted butter', quantity: 250, unit: 'g', confidence: 0.95 },
    { name: 'Walnuts', quantity: 1, unit: 'pkt', confidence: 0.9 },
    { name: 'Almonds', quantity: 100, unit: 'g', confidence: 0.92 },
    { name: 'Sugar', quantity: 100, unit: 'g', confidence: 0.93 }, // filling
    { name: 'Cinnamon', quantity: 2, unit: 'tsp', confidence: 0.9 },
    { name: 'Cloves', quantity: null, unit: null, confidence: 0.7 },
    { name: 'Water', quantity: 200, unit: 'ml', confidence: 0.94 }, // syrup
    { name: 'Honey', quantity: 3, unit: 'tbsp', confidence: 0.9 },
    { name: 'Caster sugar', quantity: 400, unit: 'g', confidence: 0.93 }, // syrup
    { name: 'Cinnamon sticks', quantity: 2, unit: 'sticks', confidence: 0.85 },
  ],
  preparationNotes: 'Layer, bake, soak in syrup.',
  overallConfidence: 0.9,
  imageQuality: 'good',
};

describe('Baklava regression — every active line is visible', () => {
  const draft = draftOf(baklava);

  it('shows all 11 active ingredient lines in the draft', () => {
    expect(draft.recipe.lines).toHaveLength(11);
  });

  it('parses the honey (tbsp) and cinnamon (tsp) lines as ready', () => {
    const honey = draft.recipe.lines.find((l) => l.ingredientName === 'Honey')!;
    const cinnamon = draft.recipe.lines.find((l) => l.ingredientName === 'Cinnamon')!;
    expect(honey.status).toBe('ready');
    expect(honey.unitToken).toBe('tbsp');
    expect(cinnamon.status).toBe('ready');
  });

  it('keeps the quantity-less cloves line visible as needs_review', () => {
    expect(codesFor(draft, 'Cloves')).toContain('MISSING_QUANTITY');
    expect(draft.recipe.lines.find((l) => l.ingredientName === 'Cloves')!.status).toBe(
      'needs_review',
    );
  });

  it('keeps packet/stick descriptor lines visible as needs_review', () => {
    for (const name of ['Phyllo pastry', 'Walnuts', 'Cinnamon sticks']) {
      expect(codesFor(draft, name)).toContain('DESCRIPTOR_NEEDS_PACKAGE_SIZE');
    }
  });
});

describe('normalizePhotoDraftForImport — only ready lines import; review lines surface', () => {
  it('canonicalizes ready lines, merges duplicate ingredients, and lists review issues', () => {
    const draft = draftOf(baklava);
    const { recipes, issues } = normalizePhotoDraftForImport(draft);
    const recipe = recipes[0]!;

    // 7 distinct ready ingredients (the two sugar lines differ by name, so NOT merged).
    const names = recipe.lines.map((l) => l.normalizedName).sort();
    expect(names).toEqual([
      'almonds',
      'caster sugar',
      'cinnamon',
      'honey',
      'sugar',
      'unsalted butter',
      'water',
    ]);

    const honey = recipe.lines.find((l) => l.normalizedName === 'honey')!;
    expect(honey.dimension).toBe('volume');
    expect(honey.quantityCanonical).toBeCloseTo(3 * 14.78676478125, 6);

    // The 4 needs_review lines (phyllo, walnuts, cloves, cinnamon sticks) are surfaced.
    expect(issues).toHaveLength(4);
    expect(recipe.yieldPortions).toBe(24);
  });

  it('drops ignored lines entirely and never reports them as issues', () => {
    const draft = draftOf(baklava);
    draft.recipe.lines[0]!.status = 'ignored'; // user removed the phyllo line
    const { issues } = normalizePhotoDraftForImport(draft);
    // One fewer review issue than before (phyllo no longer surfaced).
    expect(issues).toHaveLength(3);
  });
});
