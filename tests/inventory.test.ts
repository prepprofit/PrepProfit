import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import {
  createIngredient,
  getIngredientById,
  softDeleteIngredient,
} from '@/lib/data/ingredients';
import {
  listMovements,
  recordMovement,
  setLowStockThreshold,
} from '@/lib/data/inventory';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

let client: PGlite;
let db: TenantDb;
let ingredientId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const ing = await createIngredient(db, ORG_A, {
    name: 'Flour',
    dimension: 'weight',
    priceCents: 120,
  });
  ingredientId = ing.id;
});

afterAll(async () => {
  await client.close();
});

describe('recordMovement', () => {
  it('adds and subtracts canonical stock', async () => {
    const after1 = await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 1000,
    });
    expect(Number(after1?.stockQuantity)).toBe(1000);

    const after2 = await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 500,
      note: 'delivery',
    });
    expect(Number(after2?.stockQuantity)).toBe(1500);
  });

  it('clamps stock at zero on oversized stock-out', async () => {
    const after = await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: -5000,
    });
    expect(Number(after?.stockQuantity)).toBe(0);
  });

  it('records each movement in the ledger', async () => {
    const movements = await listMovements(db, ORG_A, ingredientId);
    expect(movements.length).toBe(3);
  });

  it('does not move stock for another org (returns null, no orphan ledger row)', async () => {
    const result = await recordMovement(db, ORG_B, {
      ingredientId,
      deltaCanonical: 100,
    });
    expect(result).toBeNull();
    // The foreign ingredient's ledger is untouched (no orphan row written).
    const ledger = await listMovements(db, ORG_A, ingredientId);
    expect(ledger.length).toBe(3);
  });

  it('refuses to move stock for a trashed ingredient (and writes no ledger row)', async () => {
    const ing = await createIngredient(db, ORG_A, {
      name: 'Sugar',
      dimension: 'weight',
      priceCents: 90,
    });
    await softDeleteIngredient(db, ORG_A, ing.id);

    const result = await recordMovement(db, ORG_A, {
      ingredientId: ing.id,
      deltaCanonical: 500,
    });
    expect(result).toBeNull();
    const ledger = await listMovements(db, ORG_A, ing.id);
    expect(ledger.length).toBe(0);
  });
});

describe('setLowStockThreshold', () => {
  it('sets and clears the threshold', async () => {
    const set = await setLowStockThreshold(db, ORG_A, ingredientId, 250);
    expect(Number(set?.lowStockThreshold)).toBe(250);

    const cleared = await setLowStockThreshold(db, ORG_A, ingredientId, null);
    expect(cleared?.lowStockThreshold).toBeNull();
  });

  it('does not touch another org’s ingredient', async () => {
    const result = await setLowStockThreshold(db, ORG_B, ingredientId, 250);
    expect(result).toBeNull();
    const stillOurs = await getIngredientById(db, ORG_A, ingredientId);
    expect(stillOurs?.lowStockThreshold).toBeNull();
  });
});
