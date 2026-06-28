import { describe, expect, it } from 'vitest';
import {
  aggregate,
  checkThresholds,
  rates,
  scoreDraft,
  type EvalScore,
  type ExpectedRecipe,
} from './metrics';
import type { PhotoDraftLine, PhotoExtractionDraft } from '@/lib/ai/types';

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

let idSeq = 0;
const draftLine = (over: Partial<PhotoDraftLine> & { ingredientName: string }): PhotoDraftLine => ({
  id: `l_${idSeq++}`,
  rawText: null,
  section: null,
  quantityText: null,
  quantityValue: null,
  unitToken: null,
  packageSizeValue: null,
  packageSizeUnitToken: null,
  confidence: 0.9,
  status: 'ready',
  issues: [],
  ...over,
});

const draftOf = (lines: PhotoDraftLine[]): PhotoExtractionDraft => ({
  attemptId: 'att_1',
  recipe: { name: 'Test', yieldPortions: null, preparationNotes: null, lines },
  qualityFlags: [],
  usage: { provider: 'google', model: 'gemini-test' },
});

/* -------------------------------------------------------------------------- */
/* A small golden + the matching "perfect" draft                              */
/* -------------------------------------------------------------------------- */

const golden: ExpectedRecipe = {
  slug: 'mini',
  name: 'Mini',
  yieldPortions: 4,
  lines: [
    { name: 'Flour', section: 'Dough', quantityValue: 500, unitToken: 'g', expectedStatus: 'ready' },
    { name: 'Honey', section: 'Syrup', quantityValue: 3, unitToken: 'tbsp', expectedStatus: 'ready' },
    { name: 'Cloves', section: 'Syrup', quantityValue: null, unitToken: null, expectedStatus: 'needs_review' },
    { name: 'Brandy', section: 'Syrup', quantityValue: 2, unitToken: 'tbsp', expectedStatus: 'ignored' },
  ],
};

const perfectDraft = (): PhotoExtractionDraft =>
  draftOf([
    draftLine({ ingredientName: 'Flour', section: 'Dough', quantityValue: 500, unitToken: 'g', status: 'ready' }),
    draftLine({ ingredientName: 'Honey', section: 'Syrup', quantityValue: 3, unitToken: 'tbsp', status: 'ready' }),
    draftLine({ ingredientName: 'Cloves', section: 'Syrup', quantityValue: null, unitToken: null, status: 'needs_review' }),
    draftLine({ ingredientName: 'Brandy', section: 'Syrup', quantityValue: 2, unitToken: 'tbsp', status: 'ignored' }),
  ]);

describe('scoreDraft — perfect draft', () => {
  it('scores full recall, zero loss, zero hallucination, perfect ready accuracy', () => {
    const r = rates(scoreDraft(golden, perfectDraft()).counts);
    expect(r.lineRecall).toBe(1);
    expect(r.correctableRecall).toBe(1);
    expect(r.silentLossRate).toBe(0);
    expect(r.hallucinationRate).toBe(0);
    expect(r.readyAccuracy).toBe(1);
    expect(r.ignoredAccuracy).toBe(1); // brandy correctly ignored
  });

  it('passes the launch gate', () => {
    const { passed, failures } = checkThresholds(rates(scoreDraft(golden, perfectDraft()).counts));
    expect(passed).toBe(true);
    expect(failures).toEqual([]);
  });

  it('counts only the 3 active expected lines in the recall denominator', () => {
    const c = scoreDraft(golden, perfectDraft()).counts;
    expect(c.expectedActive).toBe(3); // brandy (ignored) excluded
    expect(c.expectedIgnored).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Silent loss                                                                */
/* -------------------------------------------------------------------------- */

describe('scoreDraft — a dropped active line is silent loss', () => {
  it('flags a missing active line and fails the gate', () => {
    const draft = draftOf([
      draftLine({ ingredientName: 'Flour', section: 'Dough', quantityValue: 500, unitToken: 'g' }),
      // Honey omitted entirely — the exact Baklava-class failure.
      draftLine({ ingredientName: 'Cloves', section: 'Syrup', status: 'needs_review' }),
    ]);
    const score = scoreDraft(golden, draft);
    expect(score.counts.silentLoss).toBe(1);
    const r = rates(score.counts);
    expect(r.silentLossRate).toBeGreaterThan(0);
    expect(r.lineRecall).toBeCloseTo(2 / 3, 6);
    const { passed, failures } = checkThresholds(r);
    expect(passed).toBe(false);
    expect(failures.map((f) => f.metric)).toContain('silentLossRate');
  });
});

/* -------------------------------------------------------------------------- */
/* Visible-but-ignored counts toward line recall but not correctable recall   */
/* -------------------------------------------------------------------------- */

describe('scoreDraft — an active line wrongly ignored is visible but not correctable', () => {
  it('separates line recall from correctable recall', () => {
    const draft = draftOf([
      draftLine({ ingredientName: 'Flour', section: 'Dough', quantityValue: 500, unitToken: 'g' }),
      draftLine({ ingredientName: 'Honey', section: 'Syrup', quantityValue: 3, unitToken: 'tbsp' }),
      // The model read Cloves but the line ended up ignored — visible, not correctable.
      draftLine({ ingredientName: 'Cloves', section: 'Syrup', status: 'ignored' }),
    ]);
    const c = scoreDraft(golden, draft).counts;
    const r = rates(c);
    expect(c.silentLoss).toBe(0);
    expect(r.lineRecall).toBe(1); // all 3 active expected lines are present
    expect(r.correctableRecall).toBeCloseTo(2 / 3, 6); // cloves not correctable
  });
});

/* -------------------------------------------------------------------------- */
/* Hallucination                                                              */
/* -------------------------------------------------------------------------- */

describe('scoreDraft — an invented line is a hallucination', () => {
  it('counts an unmatched active draft line and never as ready-correct', () => {
    const draft = perfectDraft();
    draft.recipe.lines.push(
      draftLine({ ingredientName: 'Saffron', quantityValue: 1, unitToken: 'g', status: 'ready' }),
    );
    const score = scoreDraft(golden, draft);
    expect(score.hallucinatedNames).toEqual(['Saffron']);
    expect(score.counts.hallucinated).toBe(1);
    const r = rates(score.counts);
    // 1 invented / 4 active draft lines (brandy is ignored, so not active).
    expect(r.hallucinationRate).toBeCloseTo(1 / 4, 6);
    // Ready lines are Flour, Honey, Saffron; only the 2 real ones are correct → 2/3.
    expect(r.readyAccuracy).toBeCloseTo(2 / 3, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Field accuracy + semantic equality                                         */
/* -------------------------------------------------------------------------- */

describe('scoreDraft — field comparison', () => {
  it('treats unit synonyms as equal (cup vs cups) and flags a wrong quantity', () => {
    const g: ExpectedRecipe = {
      slug: 'f',
      name: 'F',
      yieldPortions: null,
      lines: [{ name: 'Milk', section: null, quantityValue: 1, unitToken: 'cup', expectedStatus: 'ready' }],
    };
    const draft = draftOf([
      draftLine({ ingredientName: 'Milk', quantityValue: 2, unitToken: 'cups', status: 'ready' }),
    ]);
    const score = scoreDraft(g, draft);
    expect(score.lines[0]!.fieldErrors).toEqual(['quantity']); // unit OK, quantity wrong
    const r = rates(score.counts);
    expect(r.fieldAccuracy.unit).toBe(1);
    expect(r.fieldAccuracy.quantity).toBe(0);
    expect(r.readyAccuracy).toBe(0); // a wrong field makes the ready line not correct
  });

  it('matches a name via an alias', () => {
    const g: ExpectedRecipe = {
      slug: 'a',
      name: 'A',
      yieldPortions: null,
      lines: [{ name: 'Phyllo pastry', aliases: ['filo'], section: null, quantityValue: 200, unitToken: 'g', expectedStatus: 'ready' }],
    };
    const draft = draftOf([
      draftLine({ ingredientName: 'Filo', quantityValue: 200, unitToken: 'g', status: 'ready' }),
    ]);
    const score = scoreDraft(g, draft);
    expect(score.counts.visible).toBe(1);
    expect(score.counts.hallucinated).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Duplicate draft lines cannot inflate recall                                */
/* -------------------------------------------------------------------------- */

describe('scoreDraft — duplicate draft line', () => {
  it('pairs each expected line to at most one draft line; the extra is a hallucination', () => {
    const g: ExpectedRecipe = {
      slug: 'd',
      name: 'D',
      yieldPortions: null,
      lines: [{ name: 'Sugar', section: null, quantityValue: 100, unitToken: 'g', expectedStatus: 'ready' }],
    };
    const draft = draftOf([
      draftLine({ ingredientName: 'Sugar', quantityValue: 100, unitToken: 'g', status: 'ready' }),
      draftLine({ ingredientName: 'Sugar', quantityValue: 100, unitToken: 'g', status: 'ready' }),
    ]);
    const c = scoreDraft(g, draft).counts;
    expect(c.visible).toBe(1);
    expect(c.activeDraftLines).toBe(2);
    expect(c.hallucinated).toBe(1); // the second Sugar matched no expected line
  });
});

/* -------------------------------------------------------------------------- */
/* An ingredient repeated across sections pairs section-aware                  */
/* -------------------------------------------------------------------------- */

describe('scoreDraft — same name in two sections', () => {
  it('pairs each expected line to the draft line in its own section', () => {
    const g: ExpectedRecipe = {
      slug: 's',
      name: 'S',
      yieldPortions: null,
      lines: [
        { name: 'Sugar', section: 'Filling', quantityValue: 0.5, unitToken: 'cup', expectedStatus: 'ready' },
        { name: 'Sugar', section: 'Syrup', quantityValue: 4, unitToken: 'cup', expectedStatus: 'ready' },
      ],
    };
    // Draft lists the Syrup sugar FIRST — a name-only greedy match would mis-pair it.
    const draft = draftOf([
      draftLine({ ingredientName: 'Sugar', section: 'Syrup', quantityValue: 4, unitToken: 'cup', status: 'ready' }),
      draftLine({ ingredientName: 'Sugar', section: 'Filling', quantityValue: 0.5, unitToken: 'cup', status: 'ready' }),
    ]);
    const score = scoreDraft(g, draft);
    // Both pair within-section → every field correct, no hallucination, no loss.
    expect(score.counts.visible).toBe(2);
    expect(score.counts.hallucinated).toBe(0);
    expect(score.lines.every((l) => l.fieldErrors.length === 0)).toBe(true);
    expect(rates(score.counts).readyAccuracy).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Aggregation is a micro-average                                             */
/* -------------------------------------------------------------------------- */

describe('aggregate — micro-average over fixtures', () => {
  it('weights fixtures by line count, not equally', () => {
    // Fixture A: 1 active line, perfectly visible. Fixture B: 9 active lines, 3 lost.
    const a: EvalScore = {
      slug: 'a',
      counts: { ...zero(), expectedActive: 1, visible: 1, correctable: 1 },
      lines: [],
      hallucinatedNames: [],
    };
    const b: EvalScore = {
      slug: 'b',
      counts: { ...zero(), expectedActive: 9, visible: 6, correctable: 6, silentLoss: 3 },
      lines: [],
      hallucinatedNames: [],
    };
    const r = rates(aggregate([a, b]));
    // Micro-average: 7 visible / 10 active = 0.7 (NOT the macro mean of 1.0 and 0.667).
    expect(r.lineRecall).toBeCloseTo(0.7, 6);
    expect(r.silentLossRate).toBeCloseTo(0.3, 6);
  });
});

/** A zeroed EvalCounts for assembling synthetic aggregation fixtures. */
function zero() {
  return {
    expectedActive: 0,
    visible: 0,
    correctable: 0,
    silentLoss: 0,
    readyTotal: 0,
    readyCorrect: 0,
    activeDraftLines: 0,
    hallucinated: 0,
    expectedIgnored: 0,
    ignoredCorrect: 0,
    fields: {
      name: { correct: 0, total: 0 },
      quantity: { correct: 0, total: 0 },
      unit: { correct: 0, total: 0 },
      section: { correct: 0, total: 0 },
    },
  };
}
