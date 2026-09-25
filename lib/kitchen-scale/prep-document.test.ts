import { describe, expect, it } from 'vitest';
import { buildKitchenScaleDocument } from './prep-document';
import type { KitchenRecipeWorkspaceDTO } from '@/lib/data/recipe-workspace';

function baseDto(
  over: Partial<KitchenRecipeWorkspaceDTO> = {},
): KitchenRecipeWorkspaceDTO {
  return {
    role: 'kitchen',
    recipe: {
      id: 'rec_1',
      organizationId: 'org_a',
      name: 'Almond cake',
      folderId: null,
      yieldPortions: 4,
      yieldPercentage: 90,
      yieldWeightGrams: 1200,
      yieldWeightSource: 'measured',
      yieldReviewNeeded: false,
      notes: 'Legacy prep notes',
      subtitle: null,
      version: 1,
      yieldQuantity: null,
      yieldUnit: null,
      nutritionServingQuantity: null,
      nutritionServingUnit: null,
      servingsPerContainer: null,
      coverMediaId: null,
      batchTimeMinutes: null,
      saleUnit: null,
      wasteBps: null,
      deliveryPerUnitCents: 0,
      extraStepMinutes: null,
      extraStepPriceCents: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastOpenedAt: null,
      deletedAt: null,
    } as KitchenRecipeWorkspaceDTO['recipe'],
    ingredientLines: [],
    componentLines: [],
    portionOptions: [],
    ingredientSections: [],
    methodSections: [],
    steps: [],
    media: [],
    books: [],
    ...over,
  };
}

describe('buildKitchenScaleDocument', () => {
  it('merges ingredient and component lines by display order', () => {
    const dto = baseDto({
      ingredientLines: [
        {
          id: 'l2',
          ingredientId: 'i2',
          quantity: 480,
          sectionId: null,
          displaySortOrder: 1,
          sortOrder: 1,
          note: null,
          prepActionId: null,
          enteredQuantity: null,
          enteredUnit: null,
          ingredient: { name: 'Eggs', dimension: 'weight' },
        },
        {
          id: 'l1',
          ingredientId: 'i1',
          quantity: 500,
          sectionId: null,
          displaySortOrder: 0,
          sortOrder: 0,
          note: null,
          prepActionId: null,
          enteredQuantity: null,
          enteredUnit: null,
          ingredient: { name: 'Butter', dimension: 'weight' },
        },
      ],
      componentLines: [
        {
          id: 'c1',
          componentRecipeId: 'rec_2',
          componentRecipeName: 'Almond paste',
          quantityGrams: 300,
          sectionId: null,
          displaySortOrder: 2,
          sortOrder: 0,
          note: null,
        },
      ],
    });

    const doc = buildKitchenScaleDocument(dto);
    expect(doc.lines).toEqual([
      { id: 'l1', name: 'Butter', dimension: 'weight', quantity: 500, isSubRecipe: false },
      { id: 'l2', name: 'Eggs', dimension: 'weight', quantity: 480, isSubRecipe: false },
      { id: 'c1', name: 'Almond paste', dimension: 'weight', quantity: 300, isSubRecipe: true },
    ]);
  });

  it('builds structured method sections from steps, dropping blank instructions', () => {
    const dto = baseDto({
      methodSections: [
        { id: 's1', organizationId: 'org_a', recipeId: 'rec_1', title: 'Dough', sortOrder: 0, createdAt: new Date(), updatedAt: new Date() },
      ],
      steps: [
        { id: 'st1', organizationId: 'org_a', recipeId: 'rec_1', sectionId: null, instruction: 'Preheat oven', sortOrder: 0, createdAt: new Date(), updatedAt: new Date(), media: [] },
        { id: 'st2', organizationId: 'org_a', recipeId: 'rec_1', sectionId: 's1', instruction: 'Mix flour and butter', sortOrder: 0, createdAt: new Date(), updatedAt: new Date(), media: [] },
        { id: 'st3', organizationId: 'org_a', recipeId: 'rec_1', sectionId: 's1', instruction: '   ', sortOrder: 1, createdAt: new Date(), updatedAt: new Date(), media: [] },
      ],
    });

    const doc = buildKitchenScaleDocument(dto);
    expect(doc.method).toEqual([
      { title: '', steps: ['Preheat oven'] },
      { title: 'Dough', steps: ['Mix flour and butter'] },
    ]);
    // Structured steps exist → legacy notes are not surfaced (no duplicate content).
    expect(doc.legacyNotes).toBeNull();
  });

  it('falls back to legacy notes only when there is no structured method', () => {
    const doc = buildKitchenScaleDocument(baseDto());
    expect(doc.method).toEqual([]);
    expect(doc.legacyNotes).toBe('Legacy prep notes');
  });

  it('omits legacy notes when blank and there is no structured method', () => {
    const dto = baseDto({
      recipe: { ...baseDto().recipe, notes: '   ' },
    });
    const doc = buildKitchenScaleDocument(dto);
    expect(doc.legacyNotes).toBeNull();
  });
});
