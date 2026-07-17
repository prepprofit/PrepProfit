import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { ingredients, recipes, recipeIngredients } from '@/lib/db/schema';
import {
  createPrepAction,
  deleteIngredientEquivalency,
  deletePrepAction,
  getIngredientUom,
  loadIngredientUomByIngredient,
  updatePrepAction,
  upsertIngredientEquivalency,
} from '@/lib/data/ingredient-uom';

/**
 * UoM equivalency + prep action data layer (Recipes 2.0 Fase 4): one active
 * equivalency per ingredient, ≥2-anchor guard, prep CRUD with duplicate-name
 * and in-use protection, and cross-org RLS isolation.
 */

const ORG_A = 'org_uom_a';
const ORG_B = 'org_uom_b';

let client: PGlite;
let db: TenantDb;
let flourId: string;
let onionId: string;
let trashedId: string;
let bIngId: string;

const ANCHORS = { weightGrams: 141.75, volumeMl: 236.59, eachCount: null };

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const rows = await db
    .insert(ingredients)
    .values([
      { organizationId: ORG_A, name: 'Flour', dimension: 'weight', priceCents: 120 },
      { organizationId: ORG_A, name: 'Onion', dimension: 'count', priceCents: 50 },
      {
        organizationId: ORG_A,
        name: 'Trashed',
        dimension: 'weight',
        priceCents: 10,
        deletedAt: new Date(),
      },
      { organizationId: ORG_B, name: 'B Sugar', dimension: 'weight', priceCents: 90 },
    ])
    .returning();
  flourId = rows[0]!.id;
  onionId = rows[1]!.id;
  trashedId = rows[2]!.id;
  bIngId = rows[3]!.id;
});

afterAll(async () => {
  await client.close();
});

describe('equivalencies', () => {
  it('creates and then replaces THE single equivalency of an ingredient', async () => {
    const created = await runInOrg(db, ORG_A, (tx) =>
      upsertIngredientEquivalency(
        tx,
        ORG_A,
        flourId,
        { ...ANCHORS, source: 'manual' },
        'user_1',
      ),
    );
    if (created.status !== 'done') throw new Error(created.status);
    expect(created.equivalency.weightGrams).toBeCloseTo(141.75);

    const replaced = await runInOrg(db, ORG_A, (tx) =>
      upsertIngredientEquivalency(
        tx,
        ORG_A,
        flourId,
        { weightGrams: 120, volumeMl: 240, eachCount: 1, source: 'standard' },
        'user_2',
      ),
    );
    if (replaced.status !== 'done') throw new Error(replaced.status);
    expect(replaced.equivalency.id).toBe(created.equivalency.id);
    expect(replaced.equivalency.source).toBe('standard');
    expect(replaced.equivalency.updatedBy).toBe('user_2');

    const state = await runInOrg(db, ORG_A, (tx) => getIngredientUom(tx, ORG_A, flourId));
    expect(state.equivalency?.volumeMl).toBeCloseTo(240);
  });

  it('rejects fewer than two positive anchors', async () => {
    const result = await runInOrg(db, ORG_A, (tx) =>
      upsertIngredientEquivalency(
        tx,
        ORG_A,
        onionId,
        { weightGrams: 141.75, volumeMl: null, eachCount: null, source: 'manual' },
        'user_1',
      ),
    );
    expect(result.status).toBe('invalid_anchors');
  });

  it('is not_found for a trashed ingredient', async () => {
    const result = await runInOrg(db, ORG_A, (tx) =>
      upsertIngredientEquivalency(
        tx,
        ORG_A,
        trashedId,
        { ...ANCHORS, source: 'manual' },
        'user_1',
      ),
    );
    expect(result.status).toBe('not_found');
  });

  it('deletes and reports not_found on repeat', async () => {
    const anchors = { weightGrams: 10, volumeMl: 20, eachCount: null };
    await runInOrg(db, ORG_A, (tx) =>
      upsertIngredientEquivalency(tx, ORG_A, onionId, { ...anchors, source: 'manual' }, null),
    );
    expect(
      await runInOrg(db, ORG_A, (tx) => deleteIngredientEquivalency(tx, ORG_A, onionId)),
    ).toBe('done');
    expect(
      await runInOrg(db, ORG_A, (tx) => deleteIngredientEquivalency(tx, ORG_A, onionId)),
    ).toBe('not_found');
  });
});

describe('prep actions', () => {
  it('creates, updates and lists prep actions in sort order', async () => {
    const diced = await runInOrg(db, ORG_A, (tx) =>
      createPrepAction(tx, ORG_A, onionId, {
        name: 'diced',
        yieldBps: 7854,
        weightGrams: 110,
        volumeMl: null,
        eachCount: 1,
        sortOrder: 1,
      }),
    );
    if (diced.status !== 'done') throw new Error(diced.status);
    expect(diced.prepAction.yieldBps).toBe(7854);

    const sliced = await runInOrg(db, ORG_A, (tx) =>
      createPrepAction(tx, ORG_A, onionId, {
        name: 'sliced',
        yieldBps: 9000,
        weightGrams: null,
        volumeMl: null,
        eachCount: null,
        sortOrder: 0,
      }),
    );
    if (sliced.status !== 'done') throw new Error(sliced.status);

    const state = await runInOrg(db, ORG_A, (tx) => getIngredientUom(tx, ORG_A, onionId));
    expect(state.prepActions.map((p) => p.name)).toEqual(['sliced', 'diced']);

    const updated = await runInOrg(db, ORG_A, (tx) =>
      updatePrepAction(tx, ORG_A, diced.prepAction.id, {
        name: 'finely diced',
        yieldBps: 7000,
        weightGrams: 100,
        volumeMl: null,
        eachCount: 1,
        sortOrder: 1,
      }),
    );
    if (updated.status !== 'done') throw new Error(updated.status);
    expect(updated.prepAction.name).toBe('finely diced');
  });

  it('rejects a duplicate name (case-insensitive) per ingredient', async () => {
    const dupe = await runInOrg(db, ORG_A, (tx) =>
      createPrepAction(tx, ORG_A, onionId, {
        name: 'SLICED',
        yieldBps: 5000,
        weightGrams: null,
        volumeMl: null,
        eachCount: null,
      }),
    );
    expect(dupe.status).toBe('duplicate_name');
  });

  it('refuses to delete a prep action referenced by a recipe line', async () => {
    const state = await runInOrg(db, ORG_A, (tx) => getIngredientUom(tx, ORG_A, onionId));
    const prep = state.prepActions[0]!;

    const [recipe] = await db
      .insert(recipes)
      .values({ organizationId: ORG_A, name: 'Soup', yieldPortions: 2 })
      .returning();
    await db.insert(recipeIngredients).values({
      organizationId: ORG_A,
      recipeId: recipe!.id,
      ingredientId: onionId,
      quantity: '2',
      prepActionId: prep.id,
    });

    expect(
      await runInOrg(db, ORG_A, (tx) => deletePrepAction(tx, ORG_A, prep.id)),
    ).toBe('in_use');

    const other = state.prepActions[1]!;
    expect(
      await runInOrg(db, ORG_A, (tx) => deletePrepAction(tx, ORG_A, other.id)),
    ).toBe('done');
  });

  it('batch loader groups state per ingredient', async () => {
    const map = await runInOrg(db, ORG_A, (tx) =>
      loadIngredientUomByIngredient(tx, ORG_A, [flourId, onionId]),
    );
    expect(map.get(flourId)?.equivalency?.volumeMl).toBeCloseTo(240);
    expect(map.get(onionId)?.prepActions.length).toBeGreaterThan(0);
  });
});

/** Collects every own key of a JSON-serialized value, recursively. */
function allKeysDeep(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeysDeep(v, keys);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      allKeysDeep(v, keys);
    }
  }
  return keys;
}

describe('operational surface carries no money (deep key-scan)', () => {
  it('UoM state has no financial keys — safe for kitchen', async () => {
    const state = await runInOrg(db, ORG_A, (tx) =>
      getIngredientUom(tx, ORG_A, flourId),
    );
    const keys = allKeysDeep(JSON.parse(JSON.stringify(state)));
    for (const forbidden of [
      'priceCents',
      'pendingPriceCents',
      'needsPricing',
      'sellingPriceCents',
      'costCents',
      'targetFoodCostBps',
      'supplier',
    ]) {
      expect(keys.has(forbidden), `UoM state leaked "${forbidden}"`).toBe(false);
    }
    // Operational fields still present.
    expect(keys.has('weightGrams')).toBe(true);
    expect(keys.has('yieldBps') || state.prepActions.length === 0).toBe(true);
  });
});

describe('cross-org isolation', () => {
  it('cannot write an equivalency for another org ingredient', async () => {
    const result = await runInOrg(db, ORG_A, (tx) =>
      upsertIngredientEquivalency(tx, ORG_A, bIngId, { ...ANCHORS, source: 'manual' }, null),
    );
    expect(result.status).toBe('not_found');
  });

  it('cannot see another org UoM state', async () => {
    const state = await runInOrg(db, ORG_B, (tx) => getIngredientUom(tx, ORG_B, onionId));
    expect(state.equivalency).toBeNull();
    expect(state.prepActions).toEqual([]);
  });
});
