import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { auditLog, ingredientNutritionProfiles, ingredients } from '@/lib/db/schema';
import {
  getProfilesForIngredients,
  getUsdaProfileIdentity,
  upsertNutritionProfile,
} from '@/lib/data/ingredient-nutrition';
import { NUTRIENT_KEYS, type NutrientKey } from '@/lib/calculations/nutrition';
import type { AuditActor } from '@/lib/data/audit';

/**
 * ingredient_nutrition_profiles: RLS isolation (reads AND writes), the
 * one-profile-per-ingredient upsert, trashed-ingredient rejection, and the
 * audit event written inside the same transaction (Fase 6 slice 4).
 */

const ORG_A = 'org_nut_a';
const ORG_B = 'org_nut_b';
const ACTOR: AuditActor = {
  userId: 'user_a',
  role: 'manager',
  requestId: 'req-nut-test',
};

let client: PGlite;
let db: TenantDb;
let ingredientAId: string;
let ingredientBId: string;
let trashedAId: string;

function values(v: number | null): Record<NutrientKey, number | null> {
  const out = {} as Record<NutrientKey, number | null>;
  for (const k of NUTRIENT_KEYS) out[k] = v;
  return out;
}

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const rows = await db
    .insert(ingredients)
    .values([
      { organizationId: ORG_A, name: 'Flour A', priceCents: 100 },
      { organizationId: ORG_B, name: 'Flour B', priceCents: 100 },
    ])
    .returning();
  ingredientAId = rows[0]!.id;
  ingredientBId = rows[1]!.id;
  const [trashed] = await db
    .insert(ingredients)
    .values({
      organizationId: ORG_A,
      name: 'Trashed A',
      priceCents: 100,
      deletedAt: new Date(),
    })
    .returning();
  trashedAId = trashed!.id;

  await db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('upsertNutritionProfile', () => {
  it('creates a custom profile and audits inside the transaction', async () => {
    const result = await runInOrg(db, ORG_A, (tx) =>
      upsertNutritionProfile(
        tx,
        ORG_A,
        ingredientAId,
        {
          source: 'custom',
          fdcId: null,
          fdcDataType: null,
          sourceDescription: null,
          brandOwner: null,
          sourceUpdatedAt: null,
          values: { ...values(null), caloriesKcal: 364, proteinG: 10.3 },
        },
        ACTOR,
      ),
    );
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.profile.caloriesKcal).toBe(364);
    expect(result.profile.sodiumMg).toBeNull(); // unknown stays unknown

    const audits = await runInOrg(db, ORG_A, (tx) => tx.select().from(auditLog));
    const evt = audits.find((a) => a.action === 'ingredient.nutritionSave');
    expect(evt).toBeDefined();
    expect(evt!.metadata).toMatchObject({ ingredientId: ingredientAId, source: 'custom' });
  });

  it('a second save UPSERTS (one profile per ingredient, no duplicate row)', async () => {
    const result = await runInOrg(db, ORG_A, (tx) =>
      upsertNutritionProfile(
        tx,
        ORG_A,
        ingredientAId,
        {
          source: 'usda',
          fdcId: 12345,
          fdcDataType: 'Foundation',
          sourceDescription: 'Wheat flour, whole-grain',
          brandOwner: null,
          sourceUpdatedAt: new Date('2024-04-01'),
          values: { ...values(null), caloriesKcal: 340 },
        },
        ACTOR,
      ),
    );
    expect(result.status).toBe('done');
    const rows = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(ingredientNutritionProfiles),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('usda');
    expect(rows[0]!.fdcId).toBe(12345);
    expect(rows[0]!.caloriesKcal).toBe(340);
    expect(rows[0]!.refreshedAt).not.toBeNull();
  });

  it('rejects a trashed ingredient with not_found (no write)', async () => {
    const result = await runInOrg(db, ORG_A, (tx) =>
      upsertNutritionProfile(
        tx,
        ORG_A,
        trashedAId,
        {
          source: 'custom',
          fdcId: null,
          fdcDataType: null,
          sourceDescription: null,
          brandOwner: null,
          sourceUpdatedAt: null,
          values: values(1),
        },
        ACTOR,
      ),
    );
    expect(result).toEqual({ status: 'not_found' });
  });

  it("rejects another org's ingredient with not_found (RLS + lock)", async () => {
    const result = await runInOrg(db, ORG_A, (tx) =>
      upsertNutritionProfile(
        tx,
        ORG_A,
        ingredientBId,
        {
          source: 'custom',
          fdcId: null,
          fdcDataType: null,
          sourceDescription: null,
          brandOwner: null,
          sourceUpdatedAt: null,
          values: values(1),
        },
        ACTOR,
      ),
    );
    expect(result).toEqual({ status: 'not_found' });
  });
});

describe('getProfilesForIngredients / getUsdaProfileIdentity', () => {
  it('batch read is org-scoped and keyed by ingredient', async () => {
    const map = await runInOrg(db, ORG_A, (tx) =>
      getProfilesForIngredients(tx, ORG_A, [ingredientAId, ingredientBId, 'nope']),
    );
    expect(map.size).toBe(1);
    expect(map.get(ingredientAId)!.fdcId).toBe(12345);
  });

  it('empty input returns an empty map without querying', async () => {
    const map = await runInOrg(db, ORG_A, (tx) =>
      getProfilesForIngredients(tx, ORG_A, []),
    );
    expect(map.size).toBe(0);
  });

  it('identity resolves only for usda-sourced profiles', async () => {
    const usda = await runInOrg(db, ORG_A, (tx) =>
      getUsdaProfileIdentity(tx, ORG_A, ingredientAId),
    );
    expect(usda).toEqual({ fdcId: 12345 });
    const missing = await runInOrg(db, ORG_A, (tx) =>
      getUsdaProfileIdentity(tx, ORG_A, ingredientBId),
    );
    expect(missing).toBeNull();
  });
});

describe('RLS isolation (raw table access as tenant_app)', () => {
  it('SELECT only sees the active org rows', async () => {
    const seenByB = await runInOrg(db, ORG_B, (tx) =>
      tx.select().from(ingredientNutritionProfiles),
    );
    expect(seenByB).toHaveLength(0);
  });

  it('INSERT tagged with another org is rejected (WITH CHECK)', async () => {
    await expect(
      runInOrg(db, ORG_B, (tx) =>
        tx.insert(ingredientNutritionProfiles).values({
          organizationId: ORG_A,
          ingredientId: ingredientAId,
          source: 'custom',
        }),
      ),
    ).rejects.toThrow();
  });

  it('UPDATE cannot retag a row into another org', async () => {
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx
          .update(ingredientNutritionProfiles)
          .set({ organizationId: ORG_B }),
      ),
    ).rejects.toThrow();
  });

  it('DELETE cannot reach another org rows', async () => {
    const deleted = await runInOrg(db, ORG_B, (tx) =>
      tx.delete(ingredientNutritionProfiles).returning(),
    );
    expect(deleted).toHaveLength(0);
    const still = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(ingredientNutritionProfiles),
    );
    expect(still).toHaveLength(1);
  });
});
