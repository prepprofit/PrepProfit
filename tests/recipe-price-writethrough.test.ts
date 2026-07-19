import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { recipePortionOptions } from '@/lib/db/schema';
import { createRecipe, updateRecipe } from '@/lib/data/recipes';

/**
 * Fase 7 Slice 5 — legacy-price write-through. Every new recipe gets a default
 * portion option carrying the legacy price (NULL stays honestly NULL, never 0);
 * a CHANGED legacy price mirrors onto the option; an unchanged echo (the
 * kitchen-preserve path, or a manager save that didn't touch price) never
 * clobbers a price set in the workspace's portion options.
 */

const ORG = 'org_wt';

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

const defaultOptionOf = async (recipeId: string) => {
  const [row] = await db
    .select()
    .from(recipePortionOptions)
    .where(
      and(
        eq(recipePortionOptions.organizationId, ORG),
        eq(recipePortionOptions.recipeId, recipeId),
        eq(recipePortionOptions.isDefault, true),
      ),
    );
  return row ?? null;
};

describe('legacy price → default portion option write-through', () => {
  it('createRecipe creates a default option carrying the legacy price (or NULL)', async () => {
    const priced = await createRecipe(db, ORG, {
      name: 'Priced',
      sellingPriceCents: 950,
    });
    const option = await defaultOptionOf(priced.id);
    expect(option).not.toBeNull();
    expect(option!.name).toBe('Default serving');
    expect(option!.sellingPriceCents).toBe(950);

    const unpriced = await createRecipe(db, ORG, { name: 'Unpriced' });
    expect((await defaultOptionOf(unpriced.id))!.sellingPriceCents).toBeNull();
  });

  it('a CHANGED legacy price mirrors onto the option; clearing mirrors NULL', async () => {
    const recipe = await createRecipe(db, ORG, {
      name: 'Editable',
      sellingPriceCents: 500,
    });

    await updateRecipe(db, ORG, recipe.id, {
      name: 'Editable',
      sellingPriceCents: 700,
    });
    expect((await defaultOptionOf(recipe.id))!.sellingPriceCents).toBe(700);

    await updateRecipe(db, ORG, recipe.id, {
      name: 'Editable',
      sellingPriceCents: null,
    });
    expect((await defaultOptionOf(recipe.id))!.sellingPriceCents).toBeNull();
  });

  it('an unchanged echo never clobbers a workspace-set option price', async () => {
    const recipe = await createRecipe(db, ORG, {
      name: 'Workspace priced',
      sellingPriceCents: 500,
    });
    // Workspace raises the option price; the legacy column still says 500.
    await db
      .update(recipePortionOptions)
      .set({ sellingPriceCents: 900 })
      .where(
        and(
          eq(recipePortionOptions.organizationId, ORG),
          eq(recipePortionOptions.recipeId, recipe.id),
          eq(recipePortionOptions.isDefault, true),
        ),
      );

    // Kitchen-preserve / untouched-price save echoes 500 back — no mirror.
    await updateRecipe(db, ORG, recipe.id, {
      name: 'Workspace priced (renamed)',
      sellingPriceCents: 500,
    });
    expect((await defaultOptionOf(recipe.id))!.sellingPriceCents).toBe(900);
  });
});
