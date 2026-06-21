import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { auditLog, ingredientPriceHistory } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import { recordPriceObservation } from '@/lib/data/ingredient-pricing';

/**
 * Sprint F2 — RBAC + audit on the price write paths (owner adjustment A):
 *  - a kitchen user CANNOT change price_cents (FORBIDDEN before the write), but can
 *    still edit non-price fields;
 *  - a manager price change writes a manual history row + an `ingredient.priceUpdate`
 *    audit event;
 *  - acceptPendingCostAction is manager-only (FORBIDDEN before data) and audits
 *    `ingredient.priceAccept`.
 * The action runs against a real PGlite db (as tenant_app); only auth + db + cache
 * are mocked.
 */
const ORG = 'org_f2_authz';

const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_f2_authz',
  manager: true,
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.manager),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    withOrg: (org: string, fn: (tx: never) => unknown) =>
      realRunInOrg(h.db, org, fn as never),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  acceptPendingCostAction,
  updateIngredientAction,
} from '@/app/(app)/ingredients/actions';

let client: PGlite;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

async function newIngredient(name: string, priceCents = 100): Promise<string> {
  const ing = await runInOrg(h.db, ORG, (tx) =>
    createIngredient(tx, ORG, { name, dimension: 'weight', priceCents }),
  );
  return ing.id;
}

// Reads run under the org GUC too (tenant_app + RLS hides rows without it).
function getIng(id: string) {
  return runInOrg(h.db, ORG, (tx) => getIngredientById(tx, ORG, id));
}

function auditFor(ingredientId: string) {
  return runInOrg(h.db, ORG, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, ORG), eq(auditLog.entityId, ingredientId))),
  );
}

function historyFor(ingredientId: string) {
  return runInOrg(h.db, ORG, (tx) =>
    tx
      .select()
      .from(ingredientPriceHistory)
      .where(
        and(
          eq(ingredientPriceHistory.organizationId, ORG),
          eq(ingredientPriceHistory.ingredientId, ingredientId),
        ),
      ),
  );
}

describe('updateIngredientAction — price RBAC (adjustment A)', () => {
  it('blocks a kitchen user from changing price_cents (FORBIDDEN, no write)', async () => {
    h.manager = false;
    const id = await newIngredient('Flour-kitchen', 100);

    const res = await updateIngredientAction(id, {
      name: 'Flour-kitchen',
      dimension: 'weight',
      priceCents: 250, // changed
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FORBIDDEN');

    const ing = await getIng(id);
    expect(ing?.priceCents).toBe(100); // unchanged
    expect(await historyFor(id)).toHaveLength(0);
  });

  it('lets a kitchen user edit non-price fields (name)', async () => {
    h.manager = false;
    const id = await newIngredient('Sugar-rename', 100);

    const res = await updateIngredientAction(id, {
      name: 'Caster sugar',
      dimension: 'weight',
      priceCents: 100, // unchanged → allowed
    });
    expect(res.ok).toBe(true);
    const ing = await getIng(id);
    expect(ing?.name).toBe('Caster sugar');
  });

  it('lets a manager change the price: writes history + audit', async () => {
    h.manager = true;
    const id = await newIngredient('Butter-mgr', 900);

    const res = await updateIngredientAction(id, {
      name: 'Butter-mgr',
      dimension: 'weight',
      priceCents: 950,
    });
    expect(res.ok).toBe(true);

    const ing = await getIng(id);
    expect(ing?.priceCents).toBe(950);

    const hist = await historyFor(id);
    expect(hist).toHaveLength(1);
    expect(hist[0]?.source).toBe('manual');
    expect(hist[0]?.accepted).toBe(true);

    const audits = await auditFor(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('ingredient.priceUpdate');
    expect(audits[0]?.metadata).toMatchObject({ oldPriceCents: 900, newPriceCents: 950 });
  });
});

describe('acceptPendingCostAction — manager-only + audit', () => {
  it('returns FORBIDDEN before any data access for a kitchen user', async () => {
    h.manager = false;
    const id = await newIngredient('Cream-accept-kitchen', 100);
    await runInOrg(h.db, ORG, (tx) =>
      recordPriceObservation(tx, ORG, {
        ingredientId: id,
        source: 'order',
        packSize: 1,
        packUnit: 'kg',
        packPriceCents: 400,
      }),
    );

    const res = await acceptPendingCostAction(id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FORBIDDEN');

    const ing = await getIng(id);
    expect(ing?.priceCents).toBe(100); // not accepted
    expect(ing?.pendingPriceCents).toBe(400); // still pending
  });

  it('accepts for a manager and audits ingredient.priceAccept', async () => {
    h.manager = true;
    const id = await newIngredient('Cream-accept-mgr', 100);
    await runInOrg(h.db, ORG, (tx) =>
      recordPriceObservation(tx, ORG, {
        ingredientId: id,
        source: 'order',
        packSize: 1,
        packUnit: 'kg',
        packPriceCents: 380,
      }),
    );

    const res = await acceptPendingCostAction(id);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.priceCents).toBe(380);

    const ing = await getIng(id);
    expect(ing?.priceCents).toBe(380);
    expect(ing?.pendingPriceCents).toBeNull();

    const audits = await auditFor(id);
    expect(audits.some((a) => a.action === 'ingredient.priceAccept')).toBe(true);
  });

  it('returns INVALID_INPUT when there is nothing pending', async () => {
    h.manager = true;
    const id = await newIngredient('Cream-nopending', 100);
    const res = await acceptPendingCostAction(id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('INVALID_INPUT');
  });
});
