import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe } from '@/lib/data/recipes';
import { addRecipeIngredient } from '@/lib/data/recipe-ingredients';

/**
 * getIngredientRecipeUsageAction: read-only, names + folder paths only (no money), so it
 * is open to kitchen AND managers; org is derived server-side; a foreign or missing id is
 * NOT_FOUND (distinct from an empty result); a failing read is UNEXPECTED (distinct from
 * both) so the UI can tell "couldn't load" apart from "not used".
 */
const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  org: 'org_usage_action_a',
  role: 'kitchen' as 'kitchen' | 'manager',
  fail: false,
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => h.org),
  isManager: vi.fn(async () => h.role === 'manager'),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => h.role),
}));
vi.mock('@/lib/db', async () => {
  const { runInOrg: realRunInOrg } = await import('@/lib/db/tenant');
  return {
    withOrg: (org: string, fn: (tx: never) => unknown) => {
      if (h.fail) throw new Error('db down');
      return realRunInOrg(h.db, org, fn as never);
    },
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/observability', async (orig) => ({
  ...(await orig<typeof import('@/lib/observability')>()),
  logError: vi.fn(() => 'evt'),
}));

import { getIngredientRecipeUsageAction } from '@/app/(app)/ingredients/actions';

let client: PGlite;
let ingredientId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  await h.db.execute(sql.raw('SET ROLE tenant_app;'));
  ingredientId = await runInOrg(h.db, 'org_usage_action_a', async (tx) => {
    const ing = await createIngredient(tx, 'org_usage_action_a', { name: 'Salt', dimension: 'weight', priceCents: 10 });
    const r = await createRecipe(tx, 'org_usage_action_a', { name: 'Brine' });
    await addRecipeIngredient(tx, 'org_usage_action_a', { recipeId: r.id, ingredientId: ing.id, quantity: 5 });
    return ing.id;
  });
});

afterAll(async () => {
  await h.db.execute(sql.raw('RESET ROLE;'));
  await client.close();
});

describe('getIngredientRecipeUsageAction', () => {
  it('serves kitchen and managers alike, with names only', async () => {
    for (const role of ['kitchen', 'manager'] as const) {
      h.role = role;
      const res = await getIngredientRecipeUsageAction(ingredientId);
      expect(res).toMatchObject({ ok: true, data: { count: 1 } });
      if (res.ok) expect(Object.keys(res.data.recipes[0] ?? {}).sort()).toEqual(['folderPath', 'id', 'name', 'via']);
    }
  });

  it('is NOT_FOUND for another organization’s ingredient and for an unknown id', async () => {
    h.org = 'org_usage_action_b';
    expect(await getIngredientRecipeUsageAction(ingredientId)).toEqual({ ok: false, code: 'NOT_FOUND' });
    h.org = 'org_usage_action_a';
    expect(await getIngredientRecipeUsageAction('nope')).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('rejects malformed input and reports a failing read as UNEXPECTED, not as empty', async () => {
    expect(await getIngredientRecipeUsageAction(42)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    h.fail = true;
    expect(await getIngredientRecipeUsageAction(ingredientId)).toEqual({ ok: false, code: 'UNEXPECTED' });
    h.fail = false;
  });
});
