import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb, TenantTx } from '@/lib/db/tenant';
import { ingredients, recipes } from '@/lib/db/schema';
import { createImportJob } from '@/lib/data/import-jobs';
import { createIngredient } from '@/lib/data/ingredients';
import type { ImportRecipePayload } from '@/lib/import/types';

/**
 * Proves a `recipe_photo` job (Sprint 4.7) confirms through the UNCHANGED 4.6
 * `confirmImportAction` — same `{ jobId, resolutions }` contract, same recipe-cap /
 * idempotency / forged-resolution / cross-org guards. The photo job is staged
 * directly here (its own route is tested separately) so this isolates the confirm
 * reuse: the only difference from a spreadsheet job is `entity: 'recipe_photo'`.
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
    tier: 'pro' as const,
  })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { confirmImportAction } from '@/app/(app)/import/actions';

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

/** A staged recipe_photo payload with one recipe and one new-ingredient line. */
function photoPayload(recipeName: string, notes: string | null = null): ImportRecipePayload {
  return {
    recipes: [
      {
        name: recipeName,
        yieldPortions: 8,
        yieldPercentage: 100,
        notes,
        lines: [
          {
            ingredientName: 'Flour',
            normalizedName: 'flour',
            quantityCanonical: 500,
            dimension: 'weight',
          },
        ],
      },
    ],
    resolutions: { flour: { kind: 'new' } },
  };
}

/** Stage a recipe_photo job directly (the route does this after extraction). */
async function stagePhotoJob(org: string, payload: ImportRecipePayload): Promise<string> {
  const job = await runInOrg(h.db, org, (tx) =>
    createImportJob(tx, org, {
      actorUserId: 'user_a',
      entity: 'recipe_photo',
      format: 'photo',
      sourceFilename: null,
      rowCount: payload.recipes.length,
      normalizedRows: payload,
      issues: [],
      idempotencyKey: null,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );
  return job.id;
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

async function countIngredients(org: string, name: string): Promise<number> {
  const rows = await h.db
    .select()
    .from(ingredients)
    .where(and(eq(ingredients.organizationId, org), eq(ingredients.name, name)));
  return rows.length;
}

describe('recipe_photo confirm — reuses the 4.6 path', () => {
  it('creates the recipe + new unpriced ingredient and is idempotent', async () => {
    const jobId = await stagePhotoJob('org_a', photoPayload('Photo Cake'));

    const first = await confirmImportAction(null, confirmForm(jobId, [{ name: 'flour', action: 'create' }]));
    expect(first).toMatchObject({ ok: true, phase: 'committed', entity: 'recipe_photo', created: 1 });
    expect(await countRecipes('org_a', 'Photo Cake')).toBe(1);

    const flour = await h.db
      .select()
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, 'org_a'), eq(ingredients.name, 'Flour')));
    expect(flour[0]).toMatchObject({ priceCents: 0, needsPricing: true });

    // Idempotent re-confirm applies nothing more.
    const second = await confirmImportAction(null, confirmForm(jobId, [{ name: 'flour', action: 'create' }]));
    expect(second).toMatchObject({ ok: true, alreadyCommitted: true });
    expect(await countRecipes('org_a', 'Photo Cake')).toBe(1);
  });

  it('persists the reviewed instructions/notes onto the created recipe', async () => {
    const method = 'Melt butter, add sugar + milk; boil 5 min; pour into a 9x13 pan.';
    const jobId = await stagePhotoJob('org_a', photoPayload('Fudge', method));

    const res = await confirmImportAction(null, confirmForm(jobId, [{ name: 'flour', action: 'create' }]));
    expect(res).toMatchObject({ ok: true, phase: 'committed', created: 1 });

    const [row] = await h.db
      .select({ notes: recipes.notes })
      .from(recipes)
      .where(and(eq(recipes.organizationId, 'org_a'), eq(recipes.name, 'Fudge')));
    expect(row?.notes).toBe(method);
  });

  it('rejects a link to a non-existent ingredient id and writes nothing', async () => {
    const jobId = await stagePhotoJob('org_a', photoPayload('Forged Photo'));
    const forged = await confirmImportAction(
      null,
      confirmForm(jobId, [{ name: 'flour', action: 'link', ingredientId: 'i_not_offered' }]),
    );
    expect(forged).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await countRecipes('org_a', 'Forged Photo')).toBe(0);
  });

  it('links a NEW name to an ACTIVE same-org ingredient via inline search (no duplicate)', async () => {
    const breadFlour = await createIngredient(h.db, 'org_a', {
      name: 'Bread Flour',
      dimension: 'weight',
      priceCents: 120,
    });
    const flourBefore = await countIngredients('org_a', 'Flour');
    const jobId = await stagePhotoJob('org_a', photoPayload('Inline Linked Photo'));

    const res = await confirmImportAction(
      null,
      confirmForm(jobId, [{ name: 'flour', action: 'link', ingredientId: breadFlour.id }]),
    );
    expect(res).toMatchObject({ ok: true, phase: 'committed', created: 1 });
    expect(await countRecipes('org_a', 'Inline Linked Photo')).toBe(1);
    // Linked the line to the existing ingredient → no new "Flour" row was created.
    expect(await countIngredients('org_a', 'Flour')).toBe(flourBefore);
  });

  it('rejects a link whose dimension conflicts with the line and writes nothing', async () => {
    const milk = await createIngredient(h.db, 'org_a', {
      name: 'Milk',
      dimension: 'volume',
      priceCents: 100,
    });
    // The flour line is weight; linking it to a volume ingredient must fail atomically.
    const jobId = await stagePhotoJob('org_a', photoPayload('Mismatch Photo'));

    const res = await confirmImportAction(
      null,
      confirmForm(jobId, [{ name: 'flour', action: 'link', ingredientId: milk.id }]),
    );
    expect(res).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await countRecipes('org_a', 'Mismatch Photo')).toBe(0);
  });

  it('blocks confirm with PLAN_LIMIT_REACHED when the recipe cap is hit', async () => {
    const jobId = await stagePhotoJob('org_a', photoPayload('Capped Photo'));
    h.limitAllowed = false;
    const blocked = await confirmImportAction(null, confirmForm(jobId, [{ name: 'flour', action: 'create' }]));
    expect(blocked).toEqual({ ok: false, code: 'PLAN_LIMIT_REACHED' });
    expect(await countRecipes('org_a', 'Capped Photo')).toBe(0);
  });

  it('cannot be confirmed by another org (NOT_FOUND via RLS)', async () => {
    const jobId = await stagePhotoJob('org_a', photoPayload('Foreign Photo'));
    h.org = 'org_b';
    const res = await confirmImportAction(null, confirmForm(jobId, [{ name: 'flour', action: 'create' }]));
    expect(res).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await countRecipes('org_b', 'Foreign Photo')).toBe(0);
  });
});
