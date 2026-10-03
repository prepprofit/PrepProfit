import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/lib/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@flows/react', () => ({ startWorkflow: vi.fn(async () => {}) }));
vi.mock('@/app/(app)/recipes/editor-actions', () => ({
  createRecipeFromEditorAction: vi.fn(),
  saveRecipeEditorAction: vi.fn(),
}));
vi.mock('@/app/(app)/recipes/folder-actions', () => ({ createFolderAction: vi.fn() }));

import { RecipeEditor, type RecipeEditorData } from '@/components/app/recipes/editor/recipe-editor';
import { WeightSummaryLine } from '@/components/app/recipes/editor/weight-summary';
import { weightSummary, type DraftLine } from '@/lib/recipes/editor-model';

/**
 * The recipe editor's first paint: the simplified form only (no scaling, slideshow
 * or prep-task actions), honest weight wording (an empty recipe never claims ml or
 * pieces), the shared g/kg switch, and nothing an existing recipe has is hidden.
 */
function emptyData(over: Partial<RecipeEditorData> = {}): RecipeEditorData {
  return {
    recipe: {
      id: null,
      version: null,
      name: '',
      folderId: null,
      displayUnit: 'g',
      notes: '',
      yieldPercentage: 100,
      yieldWeightSource: null,
      yieldWeightGrams: null,
      yieldReviewNeeded: false,
      coverMediaId: null,
      coverUrl: null,
    },
    sections: [],
    lines: [],
    methodSections: [],
    steps: [],
    presets: [],
    folders: [
      { id: 'f1', name: 'Pastry', parentId: null },
      { id: 'f2', name: 'Tarts', parentId: 'f1' },
    ],
    ingredientOptions: [{ id: 'flour', name: 'Flour', dimension: 'weight' }],
    componentOptions: [],
    lineUom: {},
    ...over,
  };
}

const line = (over: Partial<Extract<DraftLine, { kind: 'ingredient' }>>): DraftLine => ({
  key: over.key ?? 'l1',
  kind: 'ingredient',
  id: over.id ?? 'l1',
  ingredientId: over.ingredientId ?? 'flour',
  name: over.name ?? 'Flour',
  unitLabel: 'g',
  dimension: over.dimension ?? 'weight',
  quantity: over.quantity ?? 500,
  enteredQuantity: null,
  enteredUnit: null,
  prepActionId: null,
  note: '',
  sectionRef: null,
});

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe('RecipeEditor', () => {
  it('opens as the simplified form, without scaling, slideshow or prep-task actions', () => {
    const html = render(<RecipeEditor data={emptyData()} cancelHref="/recipes" />);
    for (const text of ['New recipe', 'Recipe name', 'Ingredients', 'Find an ingredient…', 'Preparation method / notes', 'Kitchen presets', 'Save recipe', 'Cancel']) {
      expect(html).toContain(text);
    }
    for (const text of ['Scale recipe', 'Slideshow', 'prep task', 'Prep list']) {
      expect(html).not.toContain(text);
    }
    // Only one primary save action.
    expect(html.match(/Save recipe/g)).toHaveLength(1);
  });

  it('never tells an empty recipe it has ml or piece ingredients', () => {
    const html = render(<RecipeEditor data={emptyData()} cancelHref="/recipes" />);
    expect(html).toContain('Add ingredients to see the total weight.');
    expect(html).not.toMatch(/ml or pieces/);
    expect(html).not.toContain('Adjust finished weight');
  });

  it('defaults a new recipe to grams and preselects the folder it was started in', () => {
    const data = emptyData();
    data.recipe.folderId = 'f2';
    const html = render(<RecipeEditor data={data} cancelHref="/recipes?folder=f2" />);
    expect(html).toMatch(/aria-checked="true"[^>]*data-unit="g"/);
    expect(html).toContain('Pastry › Tarts');
  });

  it('shows weight rows in the shared unit and keeps ml rows in ml', () => {
    const data = emptyData({
      lines: [line({ key: 'a', quantity: 500 }), line({ key: 'b', id: 'b', ingredientId: 'milk', name: 'Milk', dimension: 'volume', quantity: 250 })],
    });
    data.recipe.id = 'r1';
    data.recipe.version = 2;
    data.recipe.displayUnit = 'kg';
    const html = render(<RecipeEditor data={data} cancelHref="/recipes/r1" />);
    expect(html).toContain('value="0.5"');
    expect(html).toContain('value="250"');
    expect(html).toMatch(/>kg<\/span>/);
    expect(html).toMatch(/>ml<\/span>/);
    // No per-row unit dropdown on weight rows.
    expect(html).not.toContain('<option value="kg"');
    expect(html).toContain('measured in ml or pieces (Milk)');
    expect(html).toContain('Weighed ingredients: 0.5 kg');
  });

  it('keeps the saved method text and any numbered steps of an existing recipe', () => {
    const data = emptyData({
      methodSections: [{ ref: 's1', id: 's1', title: 'Dough' }],
      steps: [{ key: 'st1', id: 'st1', instruction: 'Proof overnight', sectionRef: 's1', media: [] }],
    });
    data.recipe.id = 'r1';
    data.recipe.version = 4;
    data.recipe.notes = 'Bake at 180 °C.';
    const html = render(<RecipeEditor data={data} cancelHref="/recipes/r1" />);
    expect(html).toContain('Edit recipe');
    expect(html).toContain('Bake at 180 °C.');
    expect(html).toContain('Numbered steps');
    expect(html).toContain('Proof overnight');
    expect(html).toContain('Dough');
  });
});

describe('WeightSummaryLine', () => {
  it('formats the total with grouping and names ml / piece lines only when present', () => {
    const complete = render(
      <WeightSummaryLine summary={weightSummary([line({ quantity: 1500 }), line({ key: 'b', quantity: 650 })])} displayUnit="g" />,
    );
    expect(complete).toContain('Total ingredient weight: 2,150 g');
    expect(complete).not.toContain('ml or pieces');

    const inKg = render(<WeightSummaryLine summary={weightSummary([line({ quantity: 2150 })])} displayUnit="kg" />);
    expect(inKg).toContain('Total ingredient weight: 2.15 kg');

    const empty = render(<WeightSummaryLine summary={weightSummary([])} displayUnit="g" />);
    expect(empty).toContain('Add ingredients to see the total weight.');
    expect(empty).not.toContain('ml or pieces');
  });
});
