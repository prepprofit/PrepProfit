import { describe, expect, it } from 'vitest';
import {
  addComponentLine,
  addIngredientLine,
  applyLineAmount,
  draftInputWeightGrams,
  firstComponentWithoutWeight,
  lineQuantityText,
  lineUnitLabel,
  linesForSave,
  moveLine,
  parseAmount,
  quantityMode,
  validatePresetRows,
  weightSummary,
  type DraftLine,
  type IngredientLine,
} from './editor-model';

function ingredient(over: Partial<IngredientLine> = {}): IngredientLine {
  return {
    key: over.key ?? 'l1',
    kind: 'ingredient',
    id: over.id,
    ingredientId: over.ingredientId ?? 'flour',
    name: over.name ?? 'Flour',
    unitLabel: 'g',
    dimension: over.dimension ?? 'weight',
    quantity: over.quantity ?? 500,
    enteredQuantity: over.enteredQuantity ?? null,
    enteredUnit: over.enteredUnit ?? null,
    prepActionId: over.prepActionId ?? null,
    note: over.note ?? '',
    sectionRef: over.sectionRef ?? null,
  };
}

const component = (over: Partial<Extract<DraftLine, { kind: 'component' }>> = {}): DraftLine => ({
  key: over.key ?? 'c1',
  kind: 'component',
  componentRecipeId: over.componentRecipeId ?? 'starter',
  name: over.name ?? 'Starter',
  quantityGrams: over.quantityGrams ?? 200,
  note: '',
  sectionRef: null,
});

let seq = 0;
const key = () => `k${++seq}`;

describe('parseAmount', () => {
  it('accepts decimal commas and decimal points', () => {
    expect(parseAmount('0,5')).toBe(0.5);
    expect(parseAmount('0.5')).toBe(0.5);
    expect(parseAmount(' 12 ')).toBe(12);
    expect(parseAmount('.25')).toBe(0.25);
    expect(parseAmount('1,')).toBe(1);
  });

  it('rejects blank, negative, text and double separators', () => {
    for (const bad of ['', ' ', '-1', 'abc', '1,2,3', '1.2.3', '1e3', 'NaN', 'Infinity']) {
      expect(parseAmount(bad)).toBeNull();
    }
  });
});

describe('the shared g/kg switch', () => {
  it('shows 500 g as 0.5 kg without touching the stored grams', () => {
    const line = ingredient({ quantity: 500 });
    expect(lineQuantityText(line, 'g')).toBe('500');
    expect(lineQuantityText(line, 'kg')).toBe('0.5');
    expect(lineUnitLabel(line, 'kg')).toBe('kg');
    expect(line.quantity).toBe(500);
  });

  it('flipping the unit any number of times never drifts a quantity', () => {
    const lines: DraftLine[] = [
      ingredient({ key: 'a', quantity: 1234.56 }),
      ingredient({ key: 'b', quantity: 0.01 }),
      ingredient({ key: 'c', quantity: 333.33 }),
      component({ quantityGrams: 1005.3 }),
    ];
    const before = JSON.stringify(lines);
    for (let i = 0; i < 1000; i += 1) {
      const unit = i % 2 === 0 ? 'kg' : 'g';
      for (const l of lines) lineQuantityText(l, unit);
    }
    expect(JSON.stringify(lines)).toBe(before);
    expect(lineQuantityText(lines[0]!, 'kg')).toBe('1.23456');
    expect(lineQuantityText(lines[1]!, 'kg')).toBe('0.00001');
  });

  it('re-typing the displayed kg value stores the same grams (no rounding drift)', () => {
    for (const grams of [500, 1234.56, 0.01, 333.33, 99.99, 1005.3]) {
      const line = ingredient({ quantity: grams });
      const shown = parseAmount(lineQuantityText(line, 'kg'))!;
      const next = applyLineAmount(line, shown, 'kg') as IngredientLine;
      expect(next.quantity).toBe(grams);
    }
  });

  it('stores a quantity typed in kg as grams, rounded once to the column precision', () => {
    const line = ingredient({ quantity: 0 });
    expect((applyLineAmount(line, parseAmount('0,5')!, 'kg') as IngredientLine).quantity).toBe(500);
    expect((applyLineAmount(line, parseAmount('1.2345')!, 'kg') as IngredientLine).quantity).toBe(1234.5);
    expect((applyLineAmount(line, parseAmount('2,155')!, 'g') as IngredientLine).quantity).toBe(2.16);
  });

  it('applies to sub-recipe lines too (they are grams)', () => {
    const line = component({ quantityGrams: 200 });
    expect(lineQuantityText(line, 'kg')).toBe('0.2');
    const next = applyLineAmount(line, 0.25, 'kg');
    expect(next && next.kind === 'component' ? next.quantityGrams : null).toBe(250);
  });

  it('treats a line typed in plain g or kg as grams and drops the redundant pair on edit', () => {
    const line = ingredient({ quantity: 500, enteredQuantity: 0.5, enteredUnit: 'kg' });
    expect(quantityMode(line).kind).toBe('weight');
    expect(lineQuantityText(line, 'g')).toBe('500');
    const next = applyLineAmount(line, 750, 'g') as IngredientLine;
    expect(next).toMatchObject({ quantity: 750, enteredQuantity: null, enteredUnit: null });
  });

  it('rejects an amount beyond the stored column range', () => {
    expect(applyLineAmount(ingredient(), 100_000, 'kg')).toBeNull();
  });
});

describe('non-weight lines are never reinterpreted as grams', () => {
  it('keeps millilitres and pieces with their own label whatever the switch says', () => {
    const milk = ingredient({ key: 'm', name: 'Milk', dimension: 'volume', quantity: 250 });
    const eggs = ingredient({ key: 'e', name: 'Eggs', dimension: 'count', quantity: 3 });
    for (const unit of ['g', 'kg'] as const) {
      expect(lineQuantityText(milk, unit)).toBe('250');
      expect(lineUnitLabel(milk, unit)).toBe('ml');
      expect(lineQuantityText(eggs, unit)).toBe('3');
      expect(lineUnitLabel(eggs, unit)).toBe('pcs');
    }
    expect((applyLineAmount(milk, 300, 'kg') as IngredientLine).quantity).toBe(300);
  });

  it('keeps another typed unit (cups) as entered and converts through the equivalency', () => {
    const line = ingredient({ dimension: 'weight', quantity: 240, enteredQuantity: 2, enteredUnit: 'cup' });
    expect(lineQuantityText(line, 'kg')).toBe('2');
    expect(lineUnitLabel(line, 'kg')).toBe('cup');
    const uom = { anchors: { weightGrams: 120, volumeMl: 236.5882365, eachCount: null }, prepActions: [] };
    const next = applyLineAmount(line, 3, 'kg', uom) as IngredientLine;
    expect(next).toMatchObject({ enteredQuantity: 3, enteredUnit: 'cup', quantity: 360 });
  });
});

describe('adding, removing and reordering rows', () => {
  it('adds a new ingredient row with an empty quantity and returns it for focus', () => {
    const result = addIngredientLine([], { id: 'butter', name: 'Butter', dimension: 'weight' }, key);
    expect(result.added).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ key: result.focusKey, ingredientId: 'butter', quantity: 0 });
  });

  it('a repeated pick focuses the existing row instead of adding a duplicate', () => {
    const first = addIngredientLine([], { id: 'butter', name: 'Butter', dimension: 'weight' }, key);
    const again = addIngredientLine(first.lines, { id: 'butter', name: 'Butter', dimension: 'weight' }, key);
    expect(again.added).toBe(false);
    expect(again.lines).toBe(first.lines);
    expect(again.focusKey).toBe(first.focusKey);
  });

  it('labels a new ml/pieces row with its own unit', () => {
    const { lines } = addIngredientLine([], { id: 'milk', name: 'Milk', dimension: 'volume' }, key);
    expect(lineUnitLabel(lines[0]!, 'kg')).toBe('ml');
  });

  it('adds one row per sub-recipe', () => {
    const first = addComponentLine([], { id: 'starter', name: 'Starter' }, key);
    const again = addComponentLine(first.lines, { id: 'starter', name: 'Starter' }, key);
    expect(first.added).toBe(true);
    expect(again.added).toBe(false);
    expect(again.lines).toHaveLength(1);
  });

  it('moves a row and keeps the new order for saving', () => {
    const lines = [ingredient({ key: 'a', name: 'A' }), ingredient({ key: 'b', name: 'B' }), ingredient({ key: 'c', name: 'C' })];
    expect(moveLine(lines, 2, 0).map((l) => l.key)).toEqual(['c', 'a', 'b']);
    expect(moveLine(lines, 0, 5)).toBe(lines);
    expect(moveLine(lines, 1, 1)).toBe(lines);
  });

  it('flags a sub-recipe without a weight before saving', () => {
    expect(firstComponentWithoutWeight([ingredient({ quantity: 0 })])).toBeNull();
    expect(firstComponentWithoutWeight([component({ quantityGrams: 0 })])?.key).toBe('c1');
  });
});

describe('weightSummary', () => {
  it('says nothing about ml or pieces for an empty recipe', () => {
    expect(weightSummary([])).toEqual({ state: 'empty' });
  });

  it('adds weight lines and sub-recipes into the total', () => {
    const summary = weightSummary([ingredient({ quantity: 1500 }), ingredient({ key: 'b', quantity: 450 }), component({ quantityGrams: 200 })]);
    expect(summary).toEqual({ state: 'complete', totalGrams: 2150, missingQuantity: [] });
  });

  it('names the ml/piece lines and never calls the weighed part the whole', () => {
    const summary = weightSummary([
      ingredient({ quantity: 1000 }),
      ingredient({ key: 'm', name: 'Milk', dimension: 'volume', quantity: 250 }),
      ingredient({ key: 'e', name: 'Eggs', dimension: 'count', quantity: 3 }),
    ]);
    expect(summary).toEqual({ state: 'partial', weighedGrams: 1000, unweighed: ['Milk', 'Eggs'], missingQuantity: [] });
  });

  it('reports rows still missing a quantity', () => {
    const summary = weightSummary([ingredient({ quantity: 0, name: 'Salt' }), ingredient({ key: 'b', quantity: 100 })]);
    expect(summary).toEqual({ state: 'complete', totalGrams: 100, missingQuantity: ['Salt'] });
  });

  it('feeds the yield calculation only when everything is weighed', () => {
    expect(draftInputWeightGrams([ingredient({ quantity: 1000 }), component({ quantityGrams: 200 })])).toBe(1200);
    expect(draftInputWeightGrams([ingredient({ quantity: 1000 }), ingredient({ key: 'm', dimension: 'volume', quantity: 10 })])).toBeNull();
    expect(draftInputWeightGrams([])).toBeNull();
  });
});

describe('validatePresetRows', () => {
  it('ignores blank rows and keeps decimal gram weights', () => {
    const result = validatePresetRows([
      { key: 'a', name: '18 cm cake', weightText: '450' },
      { key: 'b', name: '', weightText: '  ' },
      { key: 'c', id: 'p1', name: 'Individual portion', weightText: '44,5' },
    ]);
    expect(result).toEqual({
      ok: true,
      presets: [
        { name: '18 cm cake', targetWeightGrams: 450 },
        { id: 'p1', name: 'Individual portion', targetWeightGrams: 44.5 },
      ],
    });
  });

  it('points at half-filled rows instead of silently dropping them', () => {
    expect(validatePresetRows([{ key: 'a', name: '', weightText: '450' }])).toEqual({ ok: false, key: 'a', problem: 'nameRequired' });
    expect(validatePresetRows([{ key: 'a', name: 'Tray', weightText: '' }])).toEqual({ ok: false, key: 'a', problem: 'weightRequired' });
    expect(validatePresetRows([{ key: 'a', name: 'Tray', weightText: '0' }])).toEqual({ ok: false, key: 'a', problem: 'weightRequired' });
    expect(validatePresetRows([{ key: 'a', name: 'Tray', weightText: '-3' }])).toEqual({ ok: false, key: 'a', problem: 'weightRequired' });
  });

  it('rejects duplicate names case-insensitively', () => {
    expect(
      validatePresetRows([
        { key: 'a', name: 'Tray', weightText: '1000' },
        { key: 'b', name: 'tray', weightText: '500' },
      ]),
    ).toEqual({ ok: false, key: 'b', problem: 'duplicate' });
  });
});

describe('linesForSave', () => {
  it('sends only the server contract fields, in order, keeping non-weight data intact', () => {
    const saved = linesForSave([
      ingredient({ key: 'new-1', quantity: 500, note: '  sifted ' }),
      ingredient({ key: 'x', id: 'line-2', dimension: 'count', quantity: 3, ingredientId: 'eggs' }),
      ingredient({ key: 'y', id: 'line-3', quantity: 240, enteredQuantity: 2, enteredUnit: 'cup', prepActionId: 'p1' }),
      component({ quantityGrams: 200 }),
    ]);
    expect(saved).toEqual([
      { kind: 'ingredient', ingredientId: 'flour', quantity: 500, prepActionId: null, enteredQuantity: null, enteredUnit: null, note: 'sifted', sectionRef: null },
      { kind: 'ingredient', id: 'line-2', ingredientId: 'eggs', quantity: 3, prepActionId: null, enteredQuantity: null, enteredUnit: null, note: null, sectionRef: null },
      { kind: 'ingredient', id: 'line-3', ingredientId: 'flour', quantity: 240, prepActionId: 'p1', enteredQuantity: 2, enteredUnit: 'cup', note: null, sectionRef: null },
      { kind: 'component', componentRecipeId: 'starter', quantityGrams: 200, note: null, sectionRef: null },
    ]);
  });
});
