import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  ingredients as ingredientsTable,
  inventoryMovements as movementsTable,
  organizationSettings,
  productionConsumptions as consumptionsTable,
  productionRecipeSnapshots as snapshotsTable,
  productions as productionsTable,
} from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';
import { MovementError } from '@/lib/data/inventory';
import {
  completeProduction,
  countProductionMovementsForIngredient,
  createProduction,
  getKitchenProduction,
  getManagerProduction,
  listTrashedProductions,
  planProduction,
  softDeleteProduction,
  voidProduction,
} from '@/lib/data/productions';
import { purgeExpired } from '@/lib/data/trash';
import { purgeCutoff, TRASH_RETENTION_DAYS } from '@/lib/trash';
import type { Production } from '@/lib/db/schema';

const ORG_A = 'org_a';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);

/** A weight recipe: one line of `lineQty` g, priced `priceCents`/kg, `stock` g on hand. */
async function makeRecipe(
  db: TenantDb,
  org: string,
  name: string,
  opts: { priceCents: number; lineQty: number; stock: number },
): Promise<{ recipeId: string; ingredientId: string }> {
  const ing = await createIngredient(db, org, {
    name: `${name}-ing`,
    dimension: 'weight',
    priceCents: opts.priceCents,
  });
  await db
    .update(ingredientsTable)
    .set({ stockQuantity: String(opts.stock) })
    .where(eq(ingredientsTable.id, ing.id));
  const recipe = await createRecipe(db, org, { name });
  const added = await addRecipeIngredient(db, org, {
    recipeId: recipe.id,
    ingredientId: ing.id,
    quantity: opts.lineQty,
  });
  if (!added.ok) throw new Error('failed to add line');
  return { recipeId: recipe.id, ingredientId: ing.id };
}

async function createPlanned(
  db: TenantDb,
  org: string,
  recipeId: string,
  qty: number,
  plannedFor = '2026-07-01',
): Promise<Production> {
  const created = await createProduction(
    db,
    org,
    { reference: 'Prep', notes: null, plannedFor },
    [{ recipeId, plannedQty: qty }],
  );
  if (created.status !== 'ok') throw new Error('create failed');
  const planned = await planProduction(
    db,
    org,
    created.production.id,
    created.production.updatedAt,
  );
  if (planned.status !== 'ok') throw new Error(`plan failed: ${planned.status}`);
  return planned.production;
}

async function stockOf(db: TenantDb, ingredientId: string): Promise<number> {
  const [row] = await db
    .select({ q: ingredientsTable.stockQuantity })
    .from(ingredientsTable)
    .where(eq(ingredientsTable.id, ingredientId));
  return Number(row!.q);
}

describe('production completion (Sprint 11b)', () => {
  let client: PGlite;
  let db: TenantDb;
  let recipeId: string; // 100g/portion @ 1000c/kg, 500g stock
  let ingredientId: string;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
    const r = await makeRecipe(db, ORG_A, 'Bread', {
      priceCents: 1000,
      lineQty: 100,
      stock: 500,
    });
    recipeId = r.recipeId;
    ingredientId = r.ingredientId;
  });

  afterEach(async () => {
    await client.close();
  });

  it('planned → completed posts one OUT movement per ingredient + freezes the snapshot', async () => {
    const planned = await createPlanned(db, ORG_A, recipeId, 3); // 100g × 3 = 300g
    const outcome = await completeProduction(db, ORG_A, planned.id, planned.updatedAt);

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.alreadyCompleted).toBe(false);
    expect(outcome.stockMoved).toBe(true);
    expect(outcome.movementCount).toBe(1);
    expect(outcome.production.status).toBe('completed');
    expect(outcome.production.completedAt).not.toBeNull();
    // costPerPortion = 100g × 1000c/kg ÷ 1000 = 100c; × 3 portions = 300c.
    expect(outcome.production.costTotalCents).toBe(300);

    // Stock decreased by the requirement.
    expect(await stockOf(db, ingredientId)).toBe(200);

    // Exactly one production OUT movement, delta = −300.
    const movements = await db
      .select()
      .from(movementsTable)
      .where(
        and(
          eq(movementsTable.organizationId, ORG_A),
          eq(movementsTable.sourceType, 'production'),
          eq(movementsTable.sourceId, planned.id),
        ),
      );
    expect(movements).toHaveLength(1);
    expect(Number(movements[0]!.deltaCanonical)).toBe(-300);

    // Consumption row links the exact movement.
    const cons = await db
      .select()
      .from(consumptionsTable)
      .where(eq(consumptionsTable.productionId, planned.id));
    expect(cons).toHaveLength(1);
    expect(cons[0]!.movementId).toBe(movements[0]!.id);
    expect(Number(cons[0]!.qtyCanonical)).toBe(300);

    // Recipe snapshot froze the per-line cost.
    const snaps = await db
      .select()
      .from(snapshotsTable)
      .where(eq(snapshotsTable.productionId, planned.id));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.plannedQty).toBe(3);
    expect(snaps[0]!.lineCostCents).toBe(300);
  });

  it('idempotent retry: completing an already-completed run is a no-op', async () => {
    const planned = await createPlanned(db, ORG_A, recipeId, 3);
    const first = await completeProduction(db, ORG_A, planned.id, planned.updatedAt);
    expect(first.status).toBe('ok');

    // Retry with the (now stale) planned timestamp → ok/no-op, nothing re-posted.
    const retry = await completeProduction(db, ORG_A, planned.id, planned.updatedAt);
    expect(retry.status).toBe('ok');
    if (retry.status !== 'ok') return;
    expect(retry.alreadyCompleted).toBe(true);
    expect(retry.movementCount).toBe(0);

    const movements = await db
      .select()
      .from(movementsTable)
      .where(eq(movementsTable.sourceType, 'production'));
    expect(movements).toHaveLength(1);
    expect(await stockOf(db, ingredientId)).toBe(200);
  });

  it('insufficient stock throws + the whole transaction rolls back', async () => {
    const r = await makeRecipe(db, ORG_A, 'Cake', {
      priceCents: 2000,
      lineQty: 100,
      stock: 100, // far less than the 300g required
    });
    const planned = await createPlanned(db, ORG_A, r.recipeId, 3);

    await expect(
      runInOrg(db, ORG_A, (tx) =>
        completeProduction(tx, ORG_A, planned.id, planned.updatedAt),
      ),
    ).rejects.toBeInstanceOf(MovementError);

    // Rolled back whole: still planned, zero snapshot/consumption rows, zero movements.
    const [row] = await db
      .select()
      .from(productionsTable)
      .where(eq(productionsTable.id, planned.id));
    expect(row!.status).toBe('planned');
    expect(row!.costTotalCents).toBeNull();
    const snaps = await db
      .select()
      .from(snapshotsTable)
      .where(eq(snapshotsTable.productionId, planned.id));
    expect(snaps).toHaveLength(0);
    const cons = await db
      .select()
      .from(consumptionsTable)
      .where(eq(consumptionsTable.productionId, planned.id));
    expect(cons).toHaveLength(0);
    const movements = await db
      .select()
      .from(movementsTable)
      .where(eq(movementsTable.sourceId, planned.id));
    expect(movements).toHaveLength(0);
    expect(await stockOf(db, r.ingredientId)).toBe(100);
  });

  it('stock control (D4): an event before the start date freezes the snapshot but posts no movement', async () => {
    await db
      .insert(organizationSettings)
      .values({ organizationId: ORG_A, stockControlStartDate: '2026-12-31' });
    // planned_for 2026-07-01 < 2026-12-31 → financial-only.
    const planned = await createPlanned(db, ORG_A, recipeId, 3, '2026-07-01');
    const outcome = await completeProduction(db, ORG_A, planned.id, planned.updatedAt);

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.stockMoved).toBe(false);
    expect(outcome.movementCount).toBe(0);
    expect(outcome.production.costTotalCents).toBe(300);

    // No movement, stock unchanged, consumption frozen with movement_id NULL.
    expect(await stockOf(db, ingredientId)).toBe(500);
    const movements = await db
      .select()
      .from(movementsTable)
      .where(eq(movementsTable.sourceType, 'production'));
    expect(movements).toHaveLength(0);
    const cons = await db
      .select()
      .from(consumptionsTable)
      .where(eq(consumptionsTable.productionId, planned.id));
    expect(cons).toHaveLength(1);
    expect(cons[0]!.movementId).toBeNull();
    expect(Number(cons[0]!.qtyCanonical)).toBe(300);
  });

  it('void restores stock and retains the row; voiding twice is a no-op', async () => {
    const planned = await createPlanned(db, ORG_A, recipeId, 3);
    const completed = await completeProduction(db, ORG_A, planned.id, planned.updatedAt);
    if (completed.status !== 'ok') throw new Error('complete failed');
    expect(await stockOf(db, ingredientId)).toBe(200);

    const voided = await voidProduction(
      db,
      ORG_A,
      planned.id,
      completed.production.updatedAt,
    );
    expect(voided.status).toBe('ok');
    if (voided.status !== 'ok') return;
    expect(voided.alreadyVoided).toBe(false);
    expect(voided.reversalCount).toBe(1);
    expect(voided.production.status).toBe('voided');
    expect(voided.production.voidedAt).not.toBeNull();
    // Stock restored to the pre-completion level.
    expect(await stockOf(db, ingredientId)).toBe(500);

    // A reversal movement was posted.
    const reversals = await db
      .select()
      .from(movementsTable)
      .where(eq(movementsTable.sourceType, 'reversal'));
    expect(reversals).toHaveLength(1);

    // Voiding again is an ok/no-op.
    const again = await voidProduction(
      db,
      ORG_A,
      planned.id,
      voided.production.updatedAt,
    );
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect(again.alreadyVoided).toBe(true);
    expect(again.reversalCount).toBe(0);
  });

  it('void of a financial-only completion posts no reversal but stays readable', async () => {
    await db
      .insert(organizationSettings)
      .values({ organizationId: ORG_A, stockControlStartDate: '2026-12-31' });
    const planned = await createPlanned(db, ORG_A, recipeId, 3, '2026-07-01');
    const completed = await completeProduction(db, ORG_A, planned.id, planned.updatedAt);
    if (completed.status !== 'ok') throw new Error('complete failed');

    const voided = await voidProduction(
      db,
      ORG_A,
      planned.id,
      completed.production.updatedAt,
    );
    expect(voided.status).toBe('ok');
    if (voided.status !== 'ok') return;
    expect(voided.reversalCount).toBe(0);

    const detail = await getKitchenProduction(db, ORG_A, planned.id);
    expect(detail?.status).toBe('voided');
    expect(detail?.completion?.consumptions).toHaveLength(1);
  });

  it('snapshot is immutable against later price/recipe changes', async () => {
    const planned = await createPlanned(db, ORG_A, recipeId, 3);
    await completeProduction(db, ORG_A, planned.id, planned.updatedAt);

    // Change the ingredient price and trash the recipe AFTER completion.
    await db
      .update(ingredientsTable)
      .set({ priceCents: 9999 })
      .where(eq(ingredientsTable.id, ingredientId));
    await softDeleteRecipe(db, ORG_A, recipeId);

    const manager = await getManagerProduction(db, ORG_A, planned.id);
    expect(manager?.cost.costCents).toBe(300); // frozen, not re-derived
    expect(manager?.completion?.consumptions[0]?.qtyCanonical).toBe(300);
    expect(manager?.lines[0]?.lineCostCents).toBe(300);
    expect(manager?.lines[0]?.recipeName).toBe('Bread'); // frozen name survives trash
  });

  it('F4: kitchen completed DTO carries no cost key; manager carries the frozen cost', async () => {
    const planned = await createPlanned(db, ORG_A, recipeId, 3);
    await completeProduction(db, ORG_A, planned.id, planned.updatedAt);

    const kitchen = await getKitchenProduction(db, ORG_A, planned.id);
    expect(kitchen?.completion?.consumptions).toHaveLength(1);
    const serialized = JSON.stringify(kitchen);
    expect(serialized).not.toContain('cost');
    expect(serialized).not.toContain('Cents');

    const manager = await getManagerProduction(db, ORG_A, planned.id);
    expect(manager?.cost.costCents).toBe(300);
  });

  it('completed/voided runs refuse soft-delete, stay out of Trash, and survive auto-purge', async () => {
    const planned = await createPlanned(db, ORG_A, recipeId, 3);
    const completed = await completeProduction(db, ORG_A, planned.id, planned.updatedAt);
    if (completed.status !== 'ok') throw new Error('complete failed');

    const del = await softDeleteProduction(
      db,
      ORG_A,
      planned.id,
      completed.production.updatedAt,
    );
    expect(del.status).toBe('not_deletable');

    const trashed = await listTrashedProductions(db, ORG_A);
    expect(trashed).toHaveLength(0);

    // Auto-purge never touches it (it is not soft-deleted).
    await purgeExpired(db, ORG_A, purgeCutoff(daysAgo(TRASH_RETENTION_DAYS + 1)));
    const [row] = await db
      .select()
      .from(productionsTable)
      .where(eq(productionsTable.id, planned.id));
    expect(row?.status).toBe('completed');
  });

  it('D6: an ingredient consumed by a completed run is pinned from purge', async () => {
    const planned = await createPlanned(db, ORG_A, recipeId, 3);
    await completeProduction(db, ORG_A, planned.id, planned.updatedAt);

    expect(
      await countProductionMovementsForIngredient(db, ORG_A, ingredientId),
    ).toBe(1);

    // Trash the ingredient (it is no longer in an active recipe path) and run purge —
    // the production movement pin keeps it (its ledger history would otherwise be lost).
    await db
      .update(ingredientsTable)
      .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 5) })
      .where(eq(ingredientsTable.id, ingredientId));
    await purgeExpired(db, ORG_A, purgeCutoff(daysAgo(TRASH_RETENTION_DAYS + 1)));

    const [ing] = await db
      .select()
      .from(ingredientsTable)
      .where(eq(ingredientsTable.id, ingredientId));
    expect(ing).toBeDefined();
  });

  it('rejects completing a non-planned row and voiding a non-completed row', async () => {
    // Draft (never planned) cannot complete.
    const draft = await createProduction(
      db,
      ORG_A,
      { reference: 'D', notes: null, plannedFor: '2026-07-01' },
      [{ recipeId, plannedQty: 1 }],
    );
    if (draft.status !== 'ok') throw new Error('create failed');
    const c = await completeProduction(
      db,
      ORG_A,
      draft.production.id,
      draft.production.updatedAt,
    );
    expect(c.status).toBe('not_completable');

    // Planned (not completed) cannot void.
    const planned = await createPlanned(db, ORG_A, recipeId, 1);
    const v = await voidProduction(db, ORG_A, planned.id, planned.updatedAt);
    expect(v.status).toBe('not_voidable');
  });

  it('a stale expectedUpdatedAt on a planned run is rejected with no writes', async () => {
    const planned = await createPlanned(db, ORG_A, recipeId, 3);
    const stale = new Date(planned.updatedAt.getTime() - 1000);
    const c = await completeProduction(db, ORG_A, planned.id, stale);
    expect(c.status).toBe('stale');

    const snaps = await db
      .select()
      .from(snapshotsTable)
      .where(eq(snapshotsTable.productionId, planned.id));
    expect(snaps).toHaveLength(0);
    expect(await stockOf(db, ingredientId)).toBe(500);
  });

  it('completing with a trashed consumed ingredient is incomplete (no write)', async () => {
    const planned = await createPlanned(db, ORG_A, recipeId, 3);
    // Trash the ingredient the recipe consumes AFTER planning.
    await db
      .update(ingredientsTable)
      .set({ deletedAt: new Date() })
      .where(eq(ingredientsTable.id, ingredientId));

    const c = await completeProduction(db, ORG_A, planned.id, planned.updatedAt);
    expect(c.status).toBe('incomplete');
    const [row] = await db
      .select()
      .from(productionsTable)
      .where(eq(productionsTable.id, planned.id));
    expect(row?.status).toBe('planned');
  });

  it('RLS: the snapshot tables are org-isolated under tenant_app', async () => {
    const ORG_B = 'org_b';
    // Complete a run in each org.
    const plannedA = await createPlanned(db, ORG_A, recipeId, 3);
    await completeProduction(db, ORG_A, plannedA.id, plannedA.updatedAt);
    const rb = await makeRecipe(db, ORG_B, 'Loaf', {
      priceCents: 1000,
      lineQty: 100,
      stock: 500,
    });
    const plannedB = await createPlanned(db, ORG_B, rb.recipeId, 2);
    await completeProduction(db, ORG_B, plannedB.id, plannedB.updatedAt);

    await db.execute(sql.raw('SET ROLE tenant_app;'));
    try {
      const aSnaps = await runInOrg(db, ORG_A, (tx) =>
        tx
          .select({ organizationId: snapshotsTable.organizationId })
          .from(snapshotsTable),
      );
      expect(aSnaps.length).toBeGreaterThan(0);
      expect(aSnaps.every((r) => r.organizationId === ORG_A)).toBe(true);

      const bCons = await runInOrg(db, ORG_B, (tx) =>
        tx
          .select({ organizationId: consumptionsTable.organizationId })
          .from(consumptionsTable),
      );
      expect(bCons.length).toBeGreaterThan(0);
      expect(bCons.every((r) => r.organizationId === ORG_B)).toBe(true);

      // No org context → RLS returns nothing (secure by default).
      const orphan = await db.select().from(snapshotsTable);
      expect(orphan).toHaveLength(0);
    } finally {
      await db.execute(sql.raw('RESET ROLE;'));
    }
  });
});
