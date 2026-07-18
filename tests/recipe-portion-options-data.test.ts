import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { auditLog, recipes, recipePortionOptions } from '@/lib/db/schema';
import {
  createPortionOption,
  deletePortionOption,
  listPortionOptions,
  setDefaultPortionOption,
  setNutritionServingPortionOption,
  updatePortionOption,
} from '@/lib/data/recipe-portion-options';
import type { AuditActor } from '@/lib/data/audit';

/**
 * Portion-option data layer (Recipes 2.0 Fase 5, §6.8): CRUD + exclusive-flag
 * moves + audit trail, all org-scoped inside runInOrg.
 */

const ORG = 'org_pod';
const OTHER_ORG = 'org_pod_other';

const actor: AuditActor = {
  userId: 'user_1',
  role: 'manager',
  requestId: 'req-pod-test',
};

let client: PGlite;
let db: TenantDb;
let recipeId: string;
let trashedRecipeId: string;
let otherOrgRecipeId: string;

const baseInput = {
  name: 'Serving',
  quantity: 1,
  unit: 'serving',
  sellingPriceCents: 1500,
  targetFoodCostBps: 3000,
};

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;

  const rows = await db
    .insert(recipes)
    .values([
      { organizationId: ORG, name: 'Bread', yieldPortions: 10 },
      {
        organizationId: ORG,
        name: 'Trashed',
        yieldPortions: 1,
        deletedAt: new Date(),
      },
      { organizationId: OTHER_ORG, name: 'Foreign', yieldPortions: 1 },
    ])
    .returning();
  recipeId = rows[0]!.id;
  trashedRecipeId = rows[1]!.id;
  otherOrgRecipeId = rows[2]!.id;
});

afterAll(async () => {
  await client.close();
});

describe('createPortionOption', () => {
  it('creates; the FIRST option becomes default automatically', async () => {
    const created = await runInOrg(db, ORG, (tx) =>
      createPortionOption(tx, ORG, recipeId, baseInput, actor),
    );
    if (created.status !== 'done') throw new Error(created.status);
    expect(created.option.isDefault).toBe(true);
    expect(created.option.sellingPriceCents).toBe(1500);

    const second = await runInOrg(db, ORG, (tx) =>
      createPortionOption(
        tx,
        ORG,
        recipeId,
        { ...baseInput, name: 'Half', quantity: 0.5, sellingPriceCents: 800 },
        actor,
      ),
    );
    if (second.status !== 'done') throw new Error(second.status);
    expect(second.option.isDefault).toBe(false);

    const audit = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'recipe.portionOptionCreate')),
    );
    expect(audit).toHaveLength(2);
    // Audit metadata carries flags only — NEVER money values.
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain('1500');
    expect(audit[0]!.metadata).toMatchObject({ hasPrice: true, hasTarget: true });
  });

  it('is not_found for trashed and cross-org recipes', async () => {
    expect(
      (
        await runInOrg(db, ORG, (tx) =>
          createPortionOption(tx, ORG, trashedRecipeId, baseInput, actor),
        )
      ).status,
    ).toBe('not_found');
    expect(
      (
        await runInOrg(db, ORG, (tx) =>
          createPortionOption(tx, ORG, otherOrgRecipeId, baseInput, actor),
        )
      ).status,
    ).toBe('not_found');
  });
});

describe('updatePortionOption', () => {
  it('updates fields and audits without money in metadata', async () => {
    const options = await runInOrg(db, ORG, (tx) =>
      listPortionOptions(tx, ORG, recipeId),
    );
    const target = options.find((o) => !o.isDefault)!;
    const updated = await runInOrg(db, ORG, (tx) =>
      updatePortionOption(
        tx,
        ORG,
        target.id,
        {
          name: 'Half portion',
          quantity: 0.5,
          unit: 'serving',
          sellingPriceCents: 900,
          targetFoodCostBps: null,
        },
        actor,
      ),
    );
    if (updated.status !== 'done') throw new Error(updated.status);
    expect(updated.option.name).toBe('Half portion');
    expect(updated.option.sellingPriceCents).toBe(900);
    expect(updated.option.targetFoodCostBps).toBeNull();

    const audit = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'recipe.portionOptionUpdate')),
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain('900');
  });

  it('is not_found for another org option', async () => {
    const options = await runInOrg(db, ORG, (tx) =>
      listPortionOptions(tx, ORG, recipeId),
    );
    const result = await runInOrg(db, OTHER_ORG, (tx) =>
      updatePortionOption(
        tx,
        OTHER_ORG,
        options[0]!.id,
        { ...baseInput, sellingPriceCents: 1 },
        actor,
      ),
    );
    expect(result.status).toBe('not_found');
  });
});

describe('exclusive flags', () => {
  it('setDefault moves the flag; the previous holder is cleared', async () => {
    const options = await runInOrg(db, ORG, (tx) =>
      listPortionOptions(tx, ORG, recipeId),
    );
    const nonDefault = options.find((o) => !o.isDefault)!;
    const moved = await runInOrg(db, ORG, (tx) =>
      setDefaultPortionOption(tx, ORG, nonDefault.id, actor),
    );
    if (moved.status !== 'done') throw new Error(moved.status);
    expect(moved.option.isDefault).toBe(true);

    const after = await runInOrg(db, ORG, (tx) =>
      listPortionOptions(tx, ORG, recipeId),
    );
    expect(after.filter((o) => o.isDefault)).toHaveLength(1);
    expect(after.find((o) => o.isDefault)!.id).toBe(nonDefault.id);
  });

  it('setNutritionServing moves its own flag independently', async () => {
    const options = await runInOrg(db, ORG, (tx) =>
      listPortionOptions(tx, ORG, recipeId),
    );
    const first = await runInOrg(db, ORG, (tx) =>
      setNutritionServingPortionOption(tx, ORG, options[0]!.id, actor),
    );
    if (first.status !== 'done') throw new Error(first.status);
    const second = await runInOrg(db, ORG, (tx) =>
      setNutritionServingPortionOption(tx, ORG, options[1]!.id, actor),
    );
    if (second.status !== 'done') throw new Error(second.status);

    const after = await runInOrg(db, ORG, (tx) =>
      listPortionOptions(tx, ORG, recipeId),
    );
    expect(after.filter((o) => o.isNutritionServing)).toHaveLength(1);
    expect(after.find((o) => o.isNutritionServing)!.id).toBe(options[1]!.id);
    // Default flag untouched by nutrition-serving moves.
    expect(after.filter((o) => o.isDefault)).toHaveLength(1);
  });
});

describe('deletePortionOption', () => {
  it('deleting the default promotes the first remaining option', async () => {
    const options = await runInOrg(db, ORG, (tx) =>
      listPortionOptions(tx, ORG, recipeId),
    );
    const current = options.find((o) => o.isDefault)!;
    const result = await runInOrg(db, ORG, (tx) =>
      deletePortionOption(tx, ORG, current.id, actor),
    );
    expect(result).toBe('done');

    const after = await runInOrg(db, ORG, (tx) =>
      listPortionOptions(tx, ORG, recipeId),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.isDefault).toBe(true);
  });

  it('is not_found on repeat and for cross-org callers', async () => {
    const [remaining] = await runInOrg(db, ORG, (tx) =>
      listPortionOptions(tx, ORG, recipeId),
    );
    expect(
      await runInOrg(db, OTHER_ORG, (tx) =>
        deletePortionOption(tx, OTHER_ORG, remaining!.id, actor),
      ),
    ).toBe('not_found');
    expect(
      await runInOrg(db, ORG, (tx) =>
        deletePortionOption(tx, ORG, remaining!.id, actor),
      ),
    ).toBe('done');
    expect(
      await runInOrg(db, ORG, (tx) =>
        deletePortionOption(tx, ORG, remaining!.id, actor),
      ),
    ).toBe('not_found');
    // No orphan flags left behind.
    const empty = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(recipePortionOptions)
        .where(
          and(
            eq(recipePortionOptions.organizationId, ORG),
            eq(recipePortionOptions.recipeId, recipeId),
          ),
        ),
    );
    expect(empty).toHaveLength(0);
  });
});
