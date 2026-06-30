import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import {
  addRecipePreset,
  listRecipePresets,
  removeRecipePreset,
  reorderRecipePresets,
  updateRecipePreset,
} from '@/lib/data/recipe-presets';
import { MAX_RECIPE_PRESETS } from '@/lib/validation/recipe-presets';

const ORG = 'org_rp';

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

async function presetNames(recipeId: string): Promise<string[]> {
  const rows = await listRecipePresets(db, ORG, recipeId);
  return rows.map((r) => r.name);
}

describe('addRecipePreset — active-parent + duplicate + cap guards', () => {
  it('adds a preset to an active recipe and appends sort_order', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Sponge' });
    const first = await addRecipePreset(db, ORG, recipe.id, {
      name: '18cm Cake',
      targetWeightGrams: 1200,
    });
    expect(first.status).toBe('ok');
    if (first.status === 'ok') {
      expect(first.row.targetWeightGrams).toBe(1200);
      expect(first.row.sortOrder).toBe(0);
    }

    const second = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Individual',
      targetWeightGrams: 120,
    });
    expect(second.status).toBe('ok');
    if (second.status === 'ok') expect(second.row.sortOrder).toBe(1);

    expect(await presetNames(recipe.id)).toEqual(['18cm Cake', 'Individual']);
  });

  it('rejects a duplicate name case-insensitively (no write)', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Dup recipe' });
    const ok = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Large',
      targetWeightGrams: 2000,
    });
    expect(ok.status).toBe('ok');

    // Trimming is the Zod boundary's job; the data layer compares the (already
    // trimmed) name case-insensitively, so a different casing is still a duplicate.
    const dup = await addRecipePreset(db, ORG, recipe.id, {
      name: 'LARGE',
      targetWeightGrams: 999,
    });
    expect(dup.status).toBe('duplicate');
    expect(await presetNames(recipe.id)).toEqual(['Large']);
  });

  it('the SAME name is allowed on a DIFFERENT recipe', async () => {
    const a = await createRecipe(db, ORG, { name: 'Recipe one' });
    const b = await createRecipe(db, ORG, { name: 'Recipe two' });
    expect(
      (await addRecipePreset(db, ORG, a.id, { name: 'Tray', targetWeightGrams: 500 }))
        .status,
    ).toBe('ok');
    expect(
      (await addRecipePreset(db, ORG, b.id, { name: 'Tray', targetWeightGrams: 500 }))
        .status,
    ).toBe('ok');
  });

  it('rejects adding to a TRASHED recipe', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Trashed parent' });
    await softDeleteRecipe(db, ORG, recipe.id);
    const result = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Nope',
      targetWeightGrams: 100,
    });
    expect(result.status).toBe('recipe_not_active');
  });

  it('rejects adding to a MISSING recipe', async () => {
    const result = await addRecipePreset(db, ORG, 'recipe_missing', {
      name: 'Nope',
      targetWeightGrams: 100,
    });
    expect(result.status).toBe('recipe_not_active');
  });

  it(`enforces the ${MAX_RECIPE_PRESETS}-preset cap`, async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Cap recipe' });
    for (let i = 0; i < MAX_RECIPE_PRESETS; i += 1) {
      const r = await addRecipePreset(db, ORG, recipe.id, {
        name: `Preset ${i}`,
        targetWeightGrams: 100 + i,
      });
      expect(r.status).toBe('ok');
    }
    const overflow = await addRecipePreset(db, ORG, recipe.id, {
      name: 'One too many',
      targetWeightGrams: 50,
    });
    expect(overflow.status).toBe('limit_reached');
  });
});

describe('updateRecipePreset', () => {
  it('renames and resets the target weight', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Update recipe' });
    const added = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Old name',
      targetWeightGrams: 300,
    });
    if (added.status !== 'ok') throw new Error('seed failed');

    const updated = await updateRecipePreset(db, ORG, recipe.id, added.row.id, {
      name: 'New name',
      targetWeightGrams: 450,
    });
    expect(updated.status).toBe('ok');
    if (updated.status === 'ok') {
      expect(updated.row.name).toBe('New name');
      expect(updated.row.targetWeightGrams).toBe(450);
    }
  });

  it('allows re-saving a preset with its own name (not a self-duplicate)', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Self rename' });
    const added = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Keep',
      targetWeightGrams: 700,
    });
    if (added.status !== 'ok') throw new Error('seed failed');
    const updated = await updateRecipePreset(db, ORG, recipe.id, added.row.id, {
      name: 'Keep',
      targetWeightGrams: 800,
    });
    expect(updated.status).toBe('ok');
  });

  it('rejects renaming onto a SIBLING preset name (duplicate)', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Sibling dup' });
    const a = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Alpha',
      targetWeightGrams: 100,
    });
    const b = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Beta',
      targetWeightGrams: 200,
    });
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('seed failed');
    const clash = await updateRecipePreset(db, ORG, recipe.id, b.row.id, {
      name: 'alpha',
      targetWeightGrams: 200,
    });
    expect(clash.status).toBe('duplicate');
  });

  it('returns not_found for a forged preset id', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Forged id' });
    const result = await updateRecipePreset(db, ORG, recipe.id, 'preset_missing', {
      name: 'Whatever',
      targetWeightGrams: 100,
    });
    expect(result.status).toBe('not_found');
  });

  it('returns not_found when the parent recipe is TRASHED', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Trashed update' });
    const added = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Doomed',
      targetWeightGrams: 100,
    });
    if (added.status !== 'ok') throw new Error('seed failed');
    await softDeleteRecipe(db, ORG, recipe.id);
    const result = await updateRecipePreset(db, ORG, recipe.id, added.row.id, {
      name: 'New',
      targetWeightGrams: 200,
    });
    expect(result.status).toBe('not_found');
  });
});

describe('removeRecipePreset', () => {
  it('removes a preset; a second remove is a no-op', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Remove recipe' });
    const added = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Gone soon',
      targetWeightGrams: 100,
    });
    if (added.status !== 'ok') throw new Error('seed failed');
    expect(await removeRecipePreset(db, ORG, recipe.id, added.row.id)).toBe(true);
    expect(await removeRecipePreset(db, ORG, recipe.id, added.row.id)).toBe(false);
  });

  it('refuses when the recipeId does not match the preset (forged pairing)', async () => {
    const recipe = await createRecipe(db, ORG, { name: 'Remove forged' });
    const other = await createRecipe(db, ORG, { name: 'Other remove' });
    const added = await addRecipePreset(db, ORG, recipe.id, {
      name: 'Mine',
      targetWeightGrams: 100,
    });
    if (added.status !== 'ok') throw new Error('seed failed');
    expect(await removeRecipePreset(db, ORG, other.id, added.row.id)).toBe(false);
  });
});

describe('reorderRecipePresets', () => {
  async function seedThree(recipeName: string) {
    const recipe = await createRecipe(db, ORG, { name: recipeName });
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C']) {
      const added = await addRecipePreset(db, ORG, recipe.id, {
        name,
        targetWeightGrams: 100,
      });
      if (added.status !== 'ok') throw new Error('seed failed');
      ids.push(added.row.id);
    }
    return { recipeId: recipe.id, ids };
  }

  async function currentOrder(recipeId: string): Promise<string[]> {
    const rows = await listRecipePresets(db, ORG, recipeId);
    return rows.map((r) => r.id);
  }

  it('renumbers to an exact new order and it survives a reload', async () => {
    const { recipeId, ids } = await seedThree('Reorder ok');
    const [a, b, c] = ids;
    const reversed = [c!, b!, a!];
    const outcome = await reorderRecipePresets(db, ORG, recipeId, reversed);
    expect(outcome).toEqual({ status: 'ok', count: 3 });
    expect(await currentOrder(recipeId)).toEqual(reversed);
  });

  it('returns stale (no writes) for a FOREIGN id', async () => {
    const { recipeId, ids } = await seedThree('Reorder foreign');
    const before = await currentOrder(recipeId);
    const outcome = await reorderRecipePresets(db, ORG, recipeId, [
      ids[0]!,
      ids[1]!,
      'preset_missing',
    ]);
    expect(outcome).toEqual({ status: 'stale' });
    expect(await currentOrder(recipeId)).toEqual(before);
  });

  it('returns stale (no writes) for a PARTIAL id set', async () => {
    const { recipeId, ids } = await seedThree('Reorder partial');
    const before = await currentOrder(recipeId);
    const outcome = await reorderRecipePresets(db, ORG, recipeId, [ids[0]!, ids[1]!]);
    expect(outcome).toEqual({ status: 'stale' });
    expect(await currentOrder(recipeId)).toEqual(before);
  });

  it('returns stale for a DUPLICATE id payload (defense in depth)', async () => {
    const { recipeId, ids } = await seedThree('Reorder dup');
    const before = await currentOrder(recipeId);
    const outcome = await reorderRecipePresets(db, ORG, recipeId, [
      ids[0]!,
      ids[0]!,
      ids[1]!,
    ]);
    expect(outcome).toEqual({ status: 'stale' });
    expect(await currentOrder(recipeId)).toEqual(before);
  });

  it('returns not_found when the parent recipe is TRASHED', async () => {
    const { recipeId, ids } = await seedThree('Reorder trashed');
    await softDeleteRecipe(db, ORG, recipeId);
    const outcome = await reorderRecipePresets(db, ORG, recipeId, [
      ids[2]!,
      ids[1]!,
      ids[0]!,
    ]);
    expect(outcome).toEqual({ status: 'not_found' });
  });
});
