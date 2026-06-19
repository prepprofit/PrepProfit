import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb, TenantTx } from '@/lib/db/tenant';
import { ingredients, recipes } from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';

/**
 * Recipe import Server Actions (Sprint 4.6) against a real PGlite DB through a
 * mocked `@/lib/db`. Proves: preview→confirm creates recipes + new (unpriced)
 * ingredients and is idempotent; a forged resolution (link to a non-offered id)
 * is rejected and writes nothing; the recipe plan cap blocks confirm all-or-
 * nothing; and a cross-org job is unreachable (NOT_FOUND).
 */
const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  withOrg: null as unknown as <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  manager: true,
  org: 'org_a',
  user: 'user_a',
  limitAllowed: true,
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => h.org),
  getUserId: vi.fn(async () => h.user),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: (org: string, fn: (tx: TenantTx) => unknown) => h.withOrg(org, fn as never),
}));

vi.mock('@/lib/entitlements', () => ({
  assertPlanLimit: vi.fn(async () => ({
    allowed: h.limitAllowed,
    limit: 50,
    tier: 'starter' as const,
  })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { previewImportAction, confirmImportAction } from '@/app/(app)/import/actions';

let client: PGlite;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  h.db = test.db as unknown as TenantDb;
  h.withOrg = (org, fn) => runInOrg(h.db, org, fn);
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  h.manager = true;
  h.org = 'org_a';
  h.user = 'user_a';
  h.limitAllowed = true;
  vi.clearAllMocks();
});

const HEADER = 'recipe,yield_portions,yield_percentage,ingredient,quantity,unit';

function previewForm(content: string): FormData {
  const fd = new FormData();
  fd.set('entity', 'recipes');
  fd.set('format', 'csv');
  fd.set('file', new File([content], 'recipes.csv', { type: 'text/csv' }));
  return fd;
}

function confirmForm(jobId: string, resolutions?: unknown): FormData {
  const fd = new FormData();
  fd.set('jobId', jobId);
  if (resolutions !== undefined) fd.set('resolutions', JSON.stringify(resolutions));
  return fd;
}

async function countRecipes(org: string, name: string): Promise<number> {
  const rows = await h.db
    .select()
    .from(recipes)
    .where(and(eq(recipes.organizationId, org), eq(recipes.name, name)));
  return rows.length;
}

describe('recipe import actions — preview then confirm', () => {
  it('creates recipes + new unpriced ingredients and is idempotent', async () => {
    const csv =
      `${HEADER}\n` +
      'Focaccia,8,100,Bread Flour,1000,g\n' +
      'Focaccia,,,Olive Oil,80,ml';

    const preview = await previewImportAction(null, previewForm(csv));
    if (!preview.ok || preview.phase !== 'preview') throw new Error('expected preview');
    expect(preview.preview.counts).toMatchObject({ total: 1, importable: 1 });
    expect(preview.preview.recipePayload?.recipes).toHaveLength(1);
    const { jobId } = preview.preview;

    const first = await confirmImportAction(null, confirmForm(jobId, []));
    expect(first).toMatchObject({ ok: true, phase: 'committed', created: 1 });
    expect(await countRecipes('org_a', 'Focaccia')).toBe(1);

    const flour = await h.db
      .select()
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, 'org_a'), eq(ingredients.name, 'Bread Flour')));
    expect(flour[0]).toMatchObject({ priceCents: 0, needsPricing: true });

    // Idempotent: a second confirm applies nothing more.
    const second = await confirmImportAction(null, confirmForm(jobId, []));
    expect(second).toMatchObject({ ok: true, alreadyCommitted: true });
    expect(await countRecipes('org_a', 'Focaccia')).toBe(1);
  });
});

describe('recipe import actions — forged resolution', () => {
  it('rejects a link to a non-offered ingredient id and writes nothing', async () => {
    await createIngredient(h.db, 'org_a', { name: 'Tomato', dimension: 'weight', priceCents: 50 });

    const preview = await previewImportAction(
      null,
      previewForm(`${HEADER}\nSalsa,1,100,Tomatoes,800,g`),
    );
    if (!preview.ok || preview.phase !== 'preview') throw new Error('expected preview');
    // 'Tomatoes' fuzzy-matches the existing 'Tomato'.
    expect(preview.preview.recipePayload?.resolutions['tomatoes']?.kind).toBe('fuzzy');

    const forged = await confirmImportAction(
      null,
      confirmForm(preview.preview.jobId, [
        { name: 'tomatoes', action: 'link', ingredientId: 'i_not_offered' },
      ]),
    );
    expect(forged).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await countRecipes('org_a', 'Salsa')).toBe(0);
  });
});

describe('recipe import actions — plan cap', () => {
  it('blocks confirm with PLAN_LIMIT_REACHED and writes nothing', async () => {
    const preview = await previewImportAction(
      null,
      previewForm(`${HEADER}\nCapped Cake,8,100,Eggs,4,count`),
    );
    if (!preview.ok || preview.phase !== 'preview') throw new Error('expected preview');

    h.limitAllowed = false;
    const blocked = await confirmImportAction(null, confirmForm(preview.preview.jobId, []));
    expect(blocked).toEqual({ ok: false, code: 'PLAN_LIMIT_REACHED' });
    expect(await countRecipes('org_a', 'Capped Cake')).toBe(0);
  });
});

describe('recipe import actions — cross-org', () => {
  it('confirming org A’s recipe job with org B active is NOT_FOUND', async () => {
    const preview = await previewImportAction(
      null,
      previewForm(`${HEADER}\nForeign Bread,2,100,Flour,500,g`),
    );
    if (!preview.ok || preview.phase !== 'preview') throw new Error('expected preview');

    h.org = 'org_b';
    const forged = await confirmImportAction(null, confirmForm(preview.preview.jobId, []));
    expect(forged).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await countRecipes('org_b', 'Foreign Bread')).toBe(0);
  });
});
