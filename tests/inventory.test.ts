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
    expect(after1.ok).toBe(true);
    if (after1.ok) expect(Number(after1.ingredient.stockQuantity)).toBe(1000);

    const after2 = await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: 500,
      note: 'delivery',
    });
    expect(after2.ok).toBe(true);
    if (after2.ok) expect(Number(after2.ingredient.stockQuantity)).toBe(1500);
  });

  it('rejects an oversized stock-out, leaving stock and the ledger untouched', async () => {
    const result = await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: -5000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient_stock');

    // Stock is unchanged (still 1500) and no ledger row was written: the ledger
    // stays authoritative (no phantom -5000 entry against a -1500 real move).
    const ing = await getIngredientById(db, ORG_A, ingredientId);
    expect(Number(ing?.stockQuantity)).toBe(1500);
    const movements = await listMovements(db, ORG_A, ingredientId);
    expect(movements.length).toBe(2);
  });

  it('records each successful movement in the ledger', async () => {
    const movements = await listMovements(db, ORG_A, ingredientId);
    expect(movements.length).toBe(2);
  });

  it('does not move stock for another org (not_found, no orphan ledger row)', async () => {
    const result = await recordMovement(db, ORG_B, {
      ingredientId,
      deltaCanonical: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
    // The foreign ingredient's ledger is untouched (no orphan row written).
    const ledger = await listMovements(db, ORG_A, ingredientId);
    expect(ledger.length).toBe(2);
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
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
    const ledger = await listMovements(db, ORG_A, ing.id);
    expect(ledger.length).toBe(0);
  });

  it('allows a stock-out down to exactly zero and records the applied delta', async () => {
    // Stock is 1500; -1500 lands exactly at zero (the boundary is allowed).
    const result = await recordMovement(db, ORG_A, {
      ingredientId,
      deltaCanonical: -1500,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Number(result.ingredient.stockQuantity)).toBe(0);

    const movements = await listMovements(db, ORG_A, ingredientId);
    expect(movements.length).toBe(3);
    // Newest first: the ledger entry equals the delta that was actually applied.
    expect(Number(movements[0]?.deltaCanonical)).toBe(-1500);
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
