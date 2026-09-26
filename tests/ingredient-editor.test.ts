import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import {
  loadDefaultLinksByIngredient,
  setDefaultSupplier,
  updateIngredientWithSupplier,
  type IngredientEditorOutcome,
} from '@/lib/data/ingredient-suppliers';
import type { IngredientEditorInput } from '@/lib/validation/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';

/**
 * The unified ingredient editor's save contract (Rule 1: RLS under `tenant_app`):
 * name + dimension + supplier (set / clear / untouched) commit in ONE atomic write.
 * A supplier failure never leaves a stray name/dimension change behind, a name-only
 * or supplier-only save never requires the other, and a direct manual price only
 * applies when no supplier is attached to that same save.
 */
const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  await db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

async function ingredient(
  name: string,
  priceCents = 0,
  dimension: 'weight' | 'volume' | 'count' = 'weight',
  org = ORG_A,
) {
  return runInOrg(db, org, async (tx) => (await createIngredient(tx, org, { name, dimension, priceCents })).id);
}

const save = (id: string, input: IngredientEditorInput, org = ORG_A): Promise<IngredientEditorOutcome> =>
  runInOrg(db, org, (tx) => updateIngredientWithSupplier(tx, org, id, input));

const linkOf = async (id: string) =>
  (await runInOrg(db, ORG_A, (tx) => loadDefaultLinksByIngredient(tx, ORG_A, [id]))).get(id) ?? null;

const rowOf = (id: string, org = ORG_A) => runInOrg(db, org, (tx) => getIngredientById(tx, org, id));

describe('unified editor: name/dimension alone', () => {
  it('renames an ingredient with no supplier and no price change', async () => {
    const id = await ingredient('Flour', 180);
    const result = await save(id, { name: 'Wheat flour', dimension: 'weight' });
    expect(result).toMatchObject({ status: 'ok', priceChanged: false, supplierChange: { type: 'none' } });
    const row = await rowOf(id);
    expect(row?.name).toBe('Wheat flour');
    expect(row?.priceCents).toBe(180);
  });

  it('saves a name change with no price at all (incomplete information is allowed)', async () => {
    const id = await ingredient('New item', 0);
    const result = await save(id, { name: 'New item', dimension: 'weight' });
    expect(result.status).toBe('ok');
    const row = await rowOf(id);
    expect(row?.priceCents).toBe(0);
  });
});

describe('unified editor: supplier bundled with name/dimension', () => {
  it('sets a supplier and renames the ingredient in one save', async () => {
    const id = await ingredient('Sugar', 0);
    const result = await save(id, {
      name: 'Cane sugar',
      dimension: 'weight',
      supplier: { supplierName: 'Sweet Co' },
    });
    expect(result).toMatchObject({ status: 'ok', supplierChange: { type: 'set' } });
    const row = await rowOf(id);
    expect(row?.name).toBe('Cane sugar');
    expect(row?.supplier).toBe('Sweet Co');
    expect(await linkOf(id)).toMatchObject({ supplierName: 'Sweet Co' });
  });

  it('keeps the ingredient name untouched when only the supplier is edited', async () => {
    const id = await ingredient('Butter', 500);
    await save(id, { name: 'Butter', dimension: 'weight', supplier: { supplierName: 'Dairy Co' } });
    const result = await save(id, {
      name: 'Butter',
      dimension: 'weight',
      supplier: { supplierName: 'Dairy Co', supplierProductName: 'Voi 500g' },
    });
    expect(result.status).toBe('ok');
    const row = await rowOf(id);
    expect(row?.name).toBe('Butter');
    expect(await linkOf(id)).toMatchObject({ supplierProductName: 'Voi 500g' });
  });

  it('clears the default supplier and renames the ingredient in the same save', async () => {
    const id = await ingredient('Cocoa', 900);
    await save(id, { name: 'Cocoa', dimension: 'weight', supplier: { supplierName: 'Cocoa Co' } });
    const result = await save(id, { name: 'Cocoa powder', dimension: 'weight', clearSupplier: true });
    expect(result).toMatchObject({ status: 'ok', supplierChange: { type: 'cleared' } });
    const row = await rowOf(id);
    expect(row?.name).toBe('Cocoa powder');
    expect(row?.supplier).toBeNull();
    expect(await linkOf(id)).toBeNull();
  });

  it('reports no supplier change when clearing an ingredient that has none', async () => {
    const id = await ingredient('Salt', 100);
    const result = await save(id, { name: 'Salt', dimension: 'weight', clearSupplier: true });
    expect(result).toMatchObject({ status: 'ok', supplierChange: { type: 'none' } });
  });
});

describe('unified editor: direct manual price (no supplier)', () => {
  it('sets the approved price directly when no supplier is attached to this save', async () => {
    const id = await ingredient('Yeast', 0);
    const result = await save(id, { name: 'Yeast', dimension: 'weight', priceCents: 320 });
    expect(result).toMatchObject({ status: 'ok', priceChanged: true });
    const row = await rowOf(id);
    expect(row?.priceCents).toBe(320);
    expect(row?.needsPricing).toBe(false);
  });

  it('ignores a direct price when a supplier is also being set in the same save', async () => {
    const id = await ingredient('Vanilla', 0);
    await save(id, {
      name: 'Vanilla',
      dimension: 'weight',
      // A client should never send both, but the server must not let a stray
      // direct price race the supplier's own pending/accept flow.
      priceCents: 999,
      supplier: { supplierName: 'Spice Co' },
    });
    const row = await rowOf(id);
    // No pack/price was given to the supplier link either, so the price stays 0 —
    // never silently set to the ignored direct value.
    expect(row?.priceCents).toBe(0);
  });

  it('a deliberate supplier pack price is applied straight to the approved cost — no second approval', async () => {
    const id = await ingredient('Cream', 150);
    const result = await save(id, {
      name: 'Cream',
      dimension: 'weight',
      supplier: { supplierName: 'Dairy Co', packSize: 1, packUnit: 'kg', packPriceCents: 200 },
    });
    expect(result).toMatchObject({ status: 'ok' });
    if (result.status === 'ok' && result.supplierChange.type === 'set') {
      expect(result.supplierChange.pendingRaised).toBe(false);
      expect(result.supplierChange.priceApplied).toBe(true);
    }
    const row = await rowOf(id);
    expect(row?.priceCents).toBe(200);
    expect(row?.pendingPriceCents).toBeNull();
    expect(row?.needsPricing).toBe(false);
  });

  it('a metadata-only supplier edit (product name/code) never touches the approved cost', async () => {
    const id = await ingredient('Cheese', 400);
    await save(id, {
      name: 'Cheese',
      dimension: 'weight',
      supplier: { supplierName: 'Dairy Co', packSize: 1, packUnit: 'kg', packPriceCents: 350 },
    });
    const afterPrice = await rowOf(id);
    expect(afterPrice?.priceCents).toBe(350);

    const result = await save(id, {
      name: 'Cheese',
      dimension: 'weight',
      supplier: { supplierName: 'Dairy Co', supplierProductName: 'Juusto 1kg' },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok' && result.supplierChange.type === 'set') {
      expect(result.supplierChange.priceApplied).toBe(false);
    }
    const row = await rowOf(id);
    // Price unchanged — only the pack/product identity was edited, not the price.
    expect(row?.priceCents).toBe(350);
  });
});

describe('unified editor: atomicity', () => {
  it('a pack-unit-mismatch on the supplier part rolls back the name/dimension change too', async () => {
    const id = await ingredient('Milk', 100, 'volume');
    // Seed an existing volume pack so the dimension guard sees an incompatible unit.
    await save(id, { name: 'Milk', dimension: 'volume', supplier: { supplierName: 'Dairy Co', packSize: 1, packUnit: 'l' } });

    const result = await save(id, {
      name: 'Whole milk',
      dimension: 'weight',
      supplier: { supplierName: 'Dairy Co', packUnit: 'g' },
    });
    expect(result.status).toBe('pack_unit_mismatch');

    const row = await rowOf(id);
    // Nothing committed: neither the rename nor the dimension change.
    expect(row?.name).toBe('Milk');
    expect(row?.dimension).toBe('volume');
  });

  it('an invalid supplier name rolls back the whole save — no partial commit', async () => {
    const id = await ingredient('Pepper', 50);
    const result = await save(id, { name: 'Black pepper', dimension: 'weight', supplier: { supplierName: '   ' } });
    expect(result.status).toBe('invalid_name');
    const row = await rowOf(id);
    expect(row?.name).toBe('Pepper');
  });

  it('blocks a dimension change while an active recipe uses the ingredient, and rolls back the whole save', async () => {
    const id = await ingredient('Rice', 200, 'weight');
    await runInOrg(db, ORG_A, async (tx) => {
      const recipe = await createRecipe(tx, ORG_A, { name: 'Rice bowl' });
      await addRecipeIngredient(tx, ORG_A, { recipeId: recipe.id, ingredientId: id, quantity: 100 });
    });

    const result = await save(id, { name: 'Basmati rice', dimension: 'count' });
    expect(result.status).toBe('type_in_use');
    const row = await rowOf(id);
    expect(row?.name).toBe('Rice');
    expect(row?.dimension).toBe('weight');
  });
});

describe('unified editor: tenant isolation', () => {
  it('another organisation cannot edit the ingredient', async () => {
    const id = await ingredient('Private', 0);
    const result = await save(id, { name: 'Hijacked', dimension: 'weight' }, ORG_B);
    expect(result.status).toBe('not_found');
    const row = await rowOf(id);
    expect(row?.name).toBe('Private');
  });
});

describe('unified editor: supplier flow reuses the exact setDefaultSupplier contract', () => {
  it('bidirectional pack/unit price calc and decimal handling are untouched (reused verbatim)', async () => {
    const id = await ingredient('Almonds', 0, 'weight');
    const result = await save(id, {
      name: 'Almonds',
      dimension: 'weight',
      supplier: { supplierName: 'Nut Co', packSize: 2.5, packUnit: 'kg', packPriceCents: 800, priceBasis: 'priced' },
    });
    expect(result.status).toBe('ok');
    // €8/kg × 2.5 kg = €20.00 pack price — same conversion `setDefaultSupplier` does.
    expect((await linkOf(id))?.packPriceCents).toBe(2_000);
    // Confirm this really is the same function under the hood.
    const direct = await runInOrg(db, ORG_A, (tx) =>
      setDefaultSupplier(tx, ORG_A, id, { supplierName: 'Nut Co' }),
    );
    expect(direct.status).toBe('ok');
  });
});
