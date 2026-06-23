import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { auditLog, storageAreas as storageAreasTable } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { recordMovement } from '@/lib/data/inventory';
import { createArea, ensureDefaultArea } from '@/lib/data/storage-areas';
import { createStockCount, updateStockCount } from '@/lib/data/inventory-areas';

/**
 * Sprint 12c RBAC + audit ordering. Area CRUD is MANAGER-ONLY (kitchen → FORBIDDEN
 * before data); transfers + count commits are kitchen OR manager. Audit metadata
 * carries ids / area ids / counts only — NEVER quantities, NEVER money.
 */
const ORG = 'org_12c_authz';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_12c_authz',
  manager: true,
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.manager),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: new Date() })),
}));

vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    getDb: () => h.db,
    withOrg: (org: string, fn: (tx: never) => unknown) => realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createAreaAction, deleteAreaAction, renameAreaAction } from '@/app/(app)/inventory/area-actions';
import {
  commitStockCountAction,
  transferStockAction,
} from '@/app/(app)/inventory/depth-actions';

let client: PGlite;
let ingredientId: string;
let defaultAreaId: string;
let barAreaId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));

  const seeded = await runInOrg(h.db, ORG, async (tx) => {
    const ing = await createIngredient(tx, ORG, { name: 'Flour', dimension: 'weight', priceCents: 100 });
    const def = await ensureDefaultArea(tx, ORG);
    const bar = await createArea(tx, ORG, 'Bar');
    if (bar.status !== 'ok') throw new Error('seed area failed');
    await recordMovement(tx, ORG, {
      ingredientId: ing.id,
      deltaCanonical: 100,
      source: { type: 'manual' },
      idempotencyKey: 'seed-open',
      storageAreaId: def.id,
    });
    return { ingredientId: ing.id, defId: def.id, barId: bar.area.id };
  });
  ingredientId = seeded.ingredientId;
  defaultAreaId = seeded.defId;
  barAreaId = seeded.barId;
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

beforeEach(() => {
  h.manager = true;
});

describe('area CRUD is manager-only', () => {
  it('kitchen gets FORBIDDEN before any data on create/rename/delete', async () => {
    h.manager = false;
    const before = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(storageAreasTable).where(eq(storageAreasTable.organizationId, ORG)),
    );

    expect((await createAreaAction({ name: 'Kitchen Bar' })).ok).toBe(false);
    const created = await createAreaAction({ name: 'Kitchen Bar 2' });
    expect(created).toEqual({ ok: false, code: 'FORBIDDEN' });

    const renamed = await renameAreaAction(barAreaId, {
      expectedUpdatedAt: new Date().toISOString(),
      name: 'Hacked',
    });
    expect(renamed).toEqual({ ok: false, code: 'FORBIDDEN' });

    const deleted = await deleteAreaAction(barAreaId, {
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(deleted).toEqual({ ok: false, code: 'FORBIDDEN' });

    // No row was created by the forbidden calls.
    const after = await runInOrg(h.db, ORG, (tx) =>
      tx.select().from(storageAreasTable).where(eq(storageAreasTable.organizationId, ORG)),
    );
    expect(after.length).toBe(before.length);
  });

  it('manager can create an area', async () => {
    const result = await createAreaAction({ name: 'Walk-in' });
    expect(result.ok).toBe(true);
  });

  it('rename returns the stale code before side effects', async () => {
    const result = await renameAreaAction(barAreaId, {
      expectedUpdatedAt: new Date(0).toISOString(),
      name: 'Stale Rename',
    });
    expect(result).toEqual({ ok: false, code: 'INVENTORY_AREA_STALE' });
  });
});

describe('transfers + counts are kitchen-allowed', () => {
  it('kitchen can transfer stock between areas', async () => {
    h.manager = false;
    const result = await transferStockAction({
      ingredientId,
      areaFromId: defaultAreaId,
      areaToId: barAreaId,
      qty: 10,
      clientTransferId: crypto.randomUUID(),
    });
    expect(result.ok).toBe(true);
  });

  it('transfer audit metadata carries ids only — no quantity', async () => {
    const transferId = crypto.randomUUID();
    const result = await transferStockAction({
      ingredientId,
      areaFromId: defaultAreaId,
      areaToId: barAreaId,
      qty: 5,
      clientTransferId: transferId,
    });
    expect(result.ok).toBe(true);

    const [event] = await runInOrg(h.db, ORG, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG), eq(auditLog.entityId, transferId))),
    );
    expect(event?.action).toBe('inventory.transfer');
    const meta = (event?.metadata ?? {}) as Record<string, unknown>;
    expect(meta).toHaveProperty('areaFrom');
    expect(meta).toHaveProperty('areaTo');
    expect(meta).not.toHaveProperty('qty');
    expect(meta).not.toHaveProperty('quantity');
  });

  it('kitchen can commit a count; audit carries counts only — no quantities/money', async () => {
    h.manager = false;
    const countId = await runInOrg(h.db, ORG, async (tx) => {
      const created = await createStockCount(tx, ORG, {
        storageAreaId: barAreaId,
        note: null,
        createdBy: 'user_1',
      });
      if (created.status !== 'ok') throw new Error('create count failed');
      const updated = await updateStockCount(tx, ORG, created.count.id, created.count.updatedAt, {
        note: null,
        items: [{ ingredientId, countedCanonical: 99 }],
      });
      if (updated.status !== 'ok') throw new Error('update count failed');
      return created.count.id;
    });

    const [draft] = await runInOrg(h.db, ORG, (tx) =>
      tx
        .select()
        .from(storageAreasTable)
        .where(eq(storageAreasTable.id, barAreaId)),
    );
    expect(draft).toBeTruthy();

    // Read the count's current token to commit.
    const token = await runInOrg(h.db, ORG, async (tx) => {
      const { getStockCountWithItems } = await import('@/lib/data/inventory-areas');
      const detail = await getStockCountWithItems(tx, ORG, countId);
      return detail!.count.updatedAt.toISOString();
    });

    const result = await commitStockCountAction(countId, { expectedUpdatedAt: token });
    expect(result.ok).toBe(true);

    const [event] = await runInOrg(h.db, ORG, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, ORG), eq(auditLog.entityId, countId))),
    );
    expect(event?.action).toBe('inventory.countCommit');
    const meta = (event?.metadata ?? {}) as Record<string, unknown>;
    expect(meta).toHaveProperty('lineCount');
    expect(meta).toHaveProperty('movementCount');
    expect(meta).not.toHaveProperty('counted');
    expect(meta).not.toHaveProperty('qty');
    expect(meta).not.toHaveProperty('value');
  });

  it('commit returns the stale code before side effects', async () => {
    const countId = await runInOrg(h.db, ORG, async (tx) => {
      const created = await createStockCount(tx, ORG, {
        storageAreaId: defaultAreaId,
        note: null,
        createdBy: 'user_1',
      });
      if (created.status !== 'ok') throw new Error('create count failed');
      return created.count.id;
    });
    const result = await commitStockCountAction(countId, {
      expectedUpdatedAt: new Date(0).toISOString(),
    });
    expect(result).toEqual({ ok: false, code: 'STOCK_COUNT_STALE' });
  });
});
