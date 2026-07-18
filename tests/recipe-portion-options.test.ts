import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { recipes, recipePortionOptions } from '@/lib/db/schema';

/**
 * recipe_portion_options table contract (Recipes 2.0 Fase 5, plan §6.8):
 * cross-org RLS isolation, the partial uniques (ONE default / ONE
 * nutrition-serving per recipe) and the CHECK constraints. The data layer and
 * actions have their own tests — this file proves the DB layer alone, running
 * as the non-privileged `tenant_app` role (the PGlite superuser bypasses even
 * FORCE RLS).
 */

const ORG_A = 'org_po_a';
const ORG_B = 'org_po_b';

let client: PGlite;
let db: TenantDb;
let recipeAId: string;
let recipeBId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const rows = await db
    .insert(recipes)
    .values([
      { organizationId: ORG_A, name: 'A Bread', yieldPortions: 4 },
      { organizationId: ORG_B, name: 'B Cake', yieldPortions: 8 },
    ])
    .returning();
  recipeAId = rows[0]!.id;
  recipeBId = rows[1]!.id;

  await db.insert(recipePortionOptions).values({
    organizationId: ORG_A,
    recipeId: recipeAId,
    name: 'Default serving',
    quantity: 1,
    unit: 'serving',
    sellingPriceCents: 1200,
    isDefault: true,
  });
  await db.insert(recipePortionOptions).values({
    organizationId: ORG_B,
    recipeId: recipeBId,
    name: 'Slice',
    quantity: 1,
    unit: 'slice',
    sellingPriceCents: 450,
    isDefault: true,
  });

  await db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

/** Full message chain of a rejected DB call (drizzle wraps the pg error). */
async function rejectionText(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    let text = '';
    let cur: unknown = e;
    while (cur instanceof Error) {
      text += `${cur.message}\n`;
      cur = cur.cause;
    }
    return text;
  }
  throw new Error('expected rejection, but the promise resolved');
}

describe('RLS isolation', () => {
  it('SELECT only sees the active org rows', async () => {
    const seenByA = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(recipePortionOptions),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]!.organizationId).toBe(ORG_A);
  });

  it('INSERT tagged with another org is rejected (WITH CHECK)', async () => {
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx.insert(recipePortionOptions).values({
          organizationId: ORG_B,
          recipeId: recipeBId,
          name: 'sneaky',
          quantity: 1,
          unit: 'serving',
        }),
      ),
    ).rejects.toThrow();
  });

  it('UPDATE cannot retag a row into another org, nor reach foreign rows', async () => {
    // An unfiltered update only reaches the active org's row.
    const updated = await runInOrg(db, ORG_A, (tx) =>
      tx
        .update(recipePortionOptions)
        .set({ name: 'renamed' })
        .returning({ org: recipePortionOptions.organizationId }),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]!.org).toBe(ORG_A);

    // Retagging the own row out of the org violates WITH CHECK.
    await expect(
      runInOrg(db, ORG_A, (tx) =>
        tx.update(recipePortionOptions).set({ organizationId: ORG_B }),
      ),
    ).rejects.toThrow();
  });

  it('DELETE cannot reach another org rows', async () => {
    const deleted = await runInOrg(db, ORG_B, (tx) =>
      tx
        .delete(recipePortionOptions)
        .returning({ org: recipePortionOptions.organizationId }),
    );
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.org).toBe(ORG_B);
    // A's row survived B's org-wide delete.
    const remaining = await runInOrg(db, ORG_A, (tx) =>
      tx.select().from(recipePortionOptions),
    );
    expect(remaining).toHaveLength(1);
  });
});

describe('constraints', () => {
  it('allows only ONE default option per recipe (partial unique)', async () => {
    expect(
      await rejectionText(
        runInOrg(db, ORG_A, (tx) =>
          tx.insert(recipePortionOptions).values({
            organizationId: ORG_A,
            recipeId: recipeAId,
            name: 'Second default',
            quantity: 2,
            unit: 'serving',
            isDefault: true,
          }),
        ),
      ),
    ).toMatch(/recipe_portion_options_one_default_key/);
  });

  it('allows only ONE nutrition-serving option per recipe (partial unique)', async () => {
    await runInOrg(db, ORG_A, (tx) =>
      tx.insert(recipePortionOptions).values({
        organizationId: ORG_A,
        recipeId: recipeAId,
        name: 'Nutrition serving',
        quantity: 100,
        unit: 'g',
        isNutritionServing: true,
      }),
    );
    expect(
      await rejectionText(
        runInOrg(db, ORG_A, (tx) =>
          tx.insert(recipePortionOptions).values({
            organizationId: ORG_A,
            recipeId: recipeAId,
            name: 'Second nutrition',
            quantity: 50,
            unit: 'g',
            isNutritionServing: true,
          }),
        ),
      ),
    ).toMatch(/recipe_portion_options_one_nutrition_key/);
  });

  it('rejects non-positive quantity, negative price and out-of-range target', async () => {
    const base = {
      organizationId: ORG_A,
      recipeId: recipeAId,
      name: 'bad',
      unit: 'serving',
    };
    expect(
      await rejectionText(
        runInOrg(db, ORG_A, (tx) =>
          tx.insert(recipePortionOptions).values({ ...base, quantity: 0 }),
        ),
      ),
    ).toMatch(/quantity_chk/);
    expect(
      await rejectionText(
        runInOrg(db, ORG_A, (tx) =>
          tx
            .insert(recipePortionOptions)
            .values({ ...base, quantity: 1, sellingPriceCents: -1 }),
        ),
      ),
    ).toMatch(/price_chk/);
    expect(
      await rejectionText(
        runInOrg(db, ORG_A, (tx) =>
          tx
            .insert(recipePortionOptions)
            .values({ ...base, quantity: 1, targetFoodCostBps: 0 }),
        ),
      ),
    ).toMatch(/target_chk/);
    expect(
      await rejectionText(
        runInOrg(db, ORG_A, (tx) =>
          tx
            .insert(recipePortionOptions)
            .values({ ...base, quantity: 1, targetFoodCostBps: 10001 }),
        ),
      ),
    ).toMatch(/target_chk/);
  });

  it('cascades with the recipe delete (composite FK)', async () => {
    await db.execute(sql.raw('RESET ROLE;'));
    const [r] = await db
      .insert(recipes)
      .values({ organizationId: ORG_A, name: 'Ephemeral', yieldPortions: 1 })
      .returning();
    await db.insert(recipePortionOptions).values({
      organizationId: ORG_A,
      recipeId: r!.id,
      name: 'x',
      quantity: 1,
      unit: 'serving',
    });
    await db.execute(sql.raw('SET ROLE tenant_app;'));
    await runInOrg(db, ORG_A, (tx) => tx.delete(recipes));
    await db.execute(sql.raw('RESET ROLE;'));
    try {
      // Superuser view: no orphan options survive the recipe delete.
      const orphans = await db.select().from(recipePortionOptions);
      expect(orphans.every((o) => o.recipeId !== r!.id)).toBe(true);
    } finally {
      await db.execute(sql.raw('SET ROLE tenant_app;'));
    }
  });
});
