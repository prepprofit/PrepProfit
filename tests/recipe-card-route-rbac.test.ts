import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { recipes } from '@/lib/db/schema';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';

/**
 * Sprint F4 — the recipe card (cost sheet) PDF route is MANAGER-ONLY. Proves a
 * kitchen role gets 403 before any data access, while a manager passes the gate and
 * gets a real PDF (200). Auth/db/next-intl are stubbed; the read hits PGlite.
 */
const ORG = 'org_card';

const h = vi.hoisted(() => ({
  db: null as unknown,
  role: 'kitchen' as 'kitchen' | 'manager',
}));

vi.mock('@/lib/auth', () => ({
  getOrgId: vi.fn(async () => ORG),
  getUserId: vi.fn(async () => 'user_1'),
  getUserRole: vi.fn(async () => h.role),
  getOrgName: vi.fn(async () => 'Test Org'),
  canSeeRecipeCosts: (role: string) => role === 'manager',
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: async (org: string, fn: (tx: unknown) => unknown) =>
    runInOrg(h.db as TenantDb, org, fn as never),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

import { GET } from '@/app/api/recipes/[id]/card/pdf/route';

let client: PGlite;
let recipeId = '';

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db;
  const [row] = await runInOrg(test.db as TenantDb, ORG, (tx) =>
    tx
      .insert(recipes)
      .values({ organizationId: ORG, name: 'Cost Sheet Recipe' })
      .returning({ id: recipes.id }),
  );
  recipeId = row!.id;
});

afterAll(async () => {
  await client.close();
});

function call(id: string) {
  return GET(new Request(`http://test/api/recipes/${id}/card/pdf`), {
    params: Promise.resolve({ id }),
  });
}

describe('recipe-card PDF route — manager-only (F4)', () => {
  it('returns 403 for kitchen before any data access', async () => {
    h.role = 'kitchen';
    const res = await call(recipeId);
    expect(res.status).toBe(403);
  });

  it('returns 200 + a PDF for a manager', async () => {
    h.role = 'manager';
    const res = await call(recipeId);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
});
