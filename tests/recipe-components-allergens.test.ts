import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { addRecipeComponent } from '@/lib/data/recipe-components';
import {
  addOrEscalateRecipeOverride,
  loadRecipeAllergenRollup,
  loadRecipeAllergensByIds,
  replaceIngredientAllergens,
} from '@/lib/data/allergens';

/** Sub-recipe allergen INHERITANCE end-to-end on PGlite (superuser, no RLS). */
const ORG = 'org_rc_all';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

describe('allergen inheritance through recipe components', () => {
  it('a parent inherits its component subtree allergens as derived', async () => {
    const milk = await createIngredient(db, ORG, {
      name: 'Milk',
      dimension: 'volume',
      priceCents: 100,
    });
    await replaceIngredientAllergens(
      db,
      ORG,
      milk.id,
      [{ allergen: 'milk', presence: 'contains' }],
      'user_1',
    );

    const cream = await createRecipe(db, ORG, {
      name: 'Inh cream',
      yieldWeightGrams: 500,
    });
    await addRecipeIngredient(db, ORG, {
      recipeId: cream.id,
      ingredientId: milk.id,
      quantity: 100,
    });
    // Component-level override on the CHILD escalates eggs.
    await addOrEscalateRecipeOverride(db, ORG, cream.id, 'eggs', 'may_contain');

    const cake = await createRecipe(db, ORG, { name: 'Inh cake' });
    const added = await addRecipeComponent(db, ORG, cake.id, {
      componentRecipeId: cream.id,
      quantityGrams: 100,
    });
    expect(added.ok).toBe(true);

    const rollup = await loadRecipeAllergenRollup(db, ORG, cake.id);
    const byAllergen = new Map(rollup.allergens.map((a) => [a.allergen, a]));
    // Ingredient-derived AND child-override allergens both inherit as DERIVED.
    expect(byAllergen.get('milk')?.derivedPresence).toBe('contains');
    expect(byAllergen.get('milk')?.effectivePresence).toBe('contains');
    expect(byAllergen.get('eggs')?.derivedPresence).toBe('may_contain');
    // Milk was reviewed on the child → the parent has no unreviewed warning.
    expect(rollup.hasUnreviewedIngredient).toBe(false);
  });

  it('bubbles the unreviewed flag up from a component subtree', async () => {
    const mystery = await createIngredient(db, ORG, {
      name: 'Mystery spice',
      dimension: 'weight',
      priceCents: 10,
    }); // never reviewed
    const child = await createRecipe(db, ORG, {
      name: 'Unrev child',
      yieldWeightGrams: 100,
    });
    await addRecipeIngredient(db, ORG, {
      recipeId: child.id,
      ingredientId: mystery.id,
      quantity: 5,
    });
    const parent = await createRecipe(db, ORG, { name: 'Unrev parent' });
    const added = await addRecipeComponent(db, ORG, parent.id, {
      componentRecipeId: child.id,
      quantityGrams: 50,
    });
    expect(added.ok).toBe(true);

    const rollups = await loadRecipeAllergensByIds(db, ORG, [parent.id]);
    expect(rollups.get(parent.id)?.hasUnreviewedIngredient).toBe(true);
  });

  it('a parent override cannot downgrade an inherited allergen', async () => {
    const nuts = await createIngredient(db, ORG, {
      name: 'Hazelnut',
      dimension: 'weight',
      priceCents: 900,
    });
    await replaceIngredientAllergens(
      db,
      ORG,
      nuts.id,
      [{ allergen: 'nuts', presence: 'contains' }],
      'user_1',
    );
    const praline = await createRecipe(db, ORG, {
      name: 'Ndg praline',
      yieldWeightGrams: 200,
    });
    await addRecipeIngredient(db, ORG, {
      recipeId: praline.id,
      ingredientId: nuts.id,
      quantity: 100,
    });
    const cake = await createRecipe(db, ORG, { name: 'Ndg cake' });
    const added = await addRecipeComponent(db, ORG, cake.id, {
      componentRecipeId: praline.id,
      quantityGrams: 50,
    });
    expect(added.ok).toBe(true);

    // Attempting a weaker override on the PARENT is a rejected downgrade.
    const result = await addOrEscalateRecipeOverride(
      db,
      ORG,
      cake.id,
      'nuts',
      'may_contain',
    );
    expect(result.status).toBe('cannot_downgrade');

    const rollup = await loadRecipeAllergenRollup(db, ORG, cake.id);
    expect(
      rollup.allergens.find((a) => a.allergen === 'nuts')?.effectivePresence,
    ).toBe('contains');
  });
});
