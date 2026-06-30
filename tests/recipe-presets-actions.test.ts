import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb, TenantTx } from '@/lib/db/tenant';
import { auditLog } from '@/lib/db/schema';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { addRecipePreset } from '@/lib/data/recipe-presets';
import { MAX_RECIPE_PRESETS } from '@/lib/validation/recipe-presets';

/**
 * Kitchen-preset Server Actions (Recipe-editor parity) against a real PGlite DB
 * through a mocked `@/lib/db`. Presets are OPERATIONAL config: BOTH roles may
 * manage them (no FORBIDDEN), NO cost field is ever accepted (Zod strips it), and
 * every mutation writes an audit row whose metadata holds ids/counts/changed fields
 * only — never the preset name or weight value. Stale reorder maps to a stable code.
 */
const h = vi.hoisted(() => ({
  db: null as unknown as TenantDb,
  withOrg: null as unknown as <T>(
    org: string,
    fn: (tx: TenantTx) => Promise<T>,
  ) => Promise<T>,
  manager: false,
  org: 'org_a',
  user: 'user_a',
}));

vi.mock('@/lib/auth', () => ({
  isManager: vi.fn(async () => h.manager),
  getOrgId: vi.fn(async () => h.org),
  getUserId: vi.fn(async () => h.user),
  getUserRole: vi.fn(async () => (h.manager ? 'manager' : 'kitchen')),
}));

vi.mock('@/lib/db', () => ({
  getDb: () => h.db,
  withOrg: (org: string, fn: (tx: TenantTx) => unknown) =>
    h.withOrg(org, fn as never),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  addRecipePresetAction,
  removeRecipePresetAction,
  reorderRecipePresetsAction,
  updateRecipePresetAction,
} from '@/app/(app)/recipes/preset-actions';

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
  h.manager = false;
  h.org = 'org_a';
  h.user = 'user_a';
  vi.clearAllMocks();
});

async function auditRowsFor(entityId: string) {
  return h.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.organizationId, h.org), eq(auditLog.entityId, entityId)));
}

describe('addRecipePresetAction', () => {
  it('lets KITCHEN create a preset and audits it (metadata has no name/weight)', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'K create' });
    const result = await addRecipePresetAction(recipe.id, {
      name: '18cm cake',
      targetWeightGrams: 1200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe('18cm cake');
    expect(result.data.targetWeightGrams).toBe(1200);

    const audits = await auditRowsFor(result.data.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('recipePreset.create');
    expect(audits[0]!.actorRole).toBe('kitchen');
    const meta = audits[0]!.metadata as Record<string, unknown>;
    expect(meta).toEqual({ recipeId: recipe.id });
    // Defense in depth: the name/weight never leak into the trail.
    expect(JSON.stringify(meta)).not.toContain('18cm cake');
    expect(JSON.stringify(meta)).not.toContain('1200');
  });

  it('STRIPS a forged cost field (Zod) — only name + weight persist', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Forged cost' });
    const result = await addRecipePresetAction(recipe.id, {
      name: 'Sneaky',
      targetWeightGrams: 500,
      priceCents: 9999,
      costCents: 9999,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The returned row is the DB row — it has no cost-bearing key at all.
    expect(result.data).not.toHaveProperty('priceCents');
    expect(result.data).not.toHaveProperty('costCents');
  });

  it('maps a duplicate name to DUPLICATE_NAME', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Dup map' });
    expect((await addRecipePresetAction(recipe.id, { name: 'Big', targetWeightGrams: 1 })).ok).toBe(true);
    const dup = await addRecipePresetAction(recipe.id, {
      name: 'big',
      targetWeightGrams: 2,
    });
    expect(dup).toEqual({ ok: false, code: 'DUPLICATE_NAME' });
  });

  it('maps the cap to RECIPE_PRESET_LIMIT_REACHED', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Cap map' });
    for (let i = 0; i < MAX_RECIPE_PRESETS; i += 1) {
      await addRecipePreset(h.db, h.org, recipe.id, {
        name: `P${i}`,
        targetWeightGrams: 100 + i,
      });
    }
    const overflow = await addRecipePresetAction(recipe.id, {
      name: 'Too many',
      targetWeightGrams: 1,
    });
    expect(overflow).toEqual({ ok: false, code: 'RECIPE_PRESET_LIMIT_REACHED' });
  });

  it('maps a trashed parent to NOT_FOUND', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Trashed map' });
    await softDeleteRecipe(h.db, h.org, recipe.id);
    const result = await addRecipePresetAction(recipe.id, {
      name: 'Nope',
      targetWeightGrams: 1,
    });
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('rejects invalid input (empty name) with INVALID_INPUT', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Bad input' });
    const result = await addRecipePresetAction(recipe.id, {
      name: '   ',
      targetWeightGrams: 1,
    });
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('updateRecipePresetAction', () => {
  it('lets KITCHEN rename + reweigh and audits changed fields only', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'K update' });
    const added = await addRecipePreset(h.db, h.org, recipe.id, {
      name: 'Old',
      targetWeightGrams: 100,
    });
    if (added.status !== 'ok') throw new Error('seed failed');
    const result = await updateRecipePresetAction(recipe.id, added.row.id, {
      name: 'New',
      targetWeightGrams: 250,
    });
    expect(result.ok).toBe(true);

    const audits = await auditRowsFor(added.row.id);
    const updateRow = audits.find((a) => a.action === 'recipePreset.update');
    expect(updateRow).toBeDefined();
    expect(updateRow!.metadata).toEqual({
      recipeId: recipe.id,
      changedFields: ['name', 'targetWeightGrams'],
    });
  });

  it('maps a sibling-name clash to DUPLICATE_NAME', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Update dup' });
    const a = await addRecipePreset(h.db, h.org, recipe.id, {
      name: 'Alpha',
      targetWeightGrams: 1,
    });
    const b = await addRecipePreset(h.db, h.org, recipe.id, {
      name: 'Beta',
      targetWeightGrams: 2,
    });
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('seed failed');
    const clash = await updateRecipePresetAction(recipe.id, b.row.id, {
      name: 'alpha',
      targetWeightGrams: 2,
    });
    expect(clash).toEqual({ ok: false, code: 'DUPLICATE_NAME' });
  });

  it('maps a forged preset id to NOT_FOUND', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Update forged' });
    const result = await updateRecipePresetAction(recipe.id, 'preset_missing', {
      name: 'X',
      targetWeightGrams: 1,
    });
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('removeRecipePresetAction', () => {
  it('lets KITCHEN remove a preset and audits the delete', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'K remove' });
    const added = await addRecipePreset(h.db, h.org, recipe.id, {
      name: 'Gone',
      targetWeightGrams: 1,
    });
    if (added.status !== 'ok') throw new Error('seed failed');
    const result = await removeRecipePresetAction(recipe.id, added.row.id);
    expect(result.ok).toBe(true);

    const audits = await auditRowsFor(added.row.id);
    expect(audits.some((a) => a.action === 'recipePreset.delete')).toBe(true);
  });

  it('maps a forged id to NOT_FOUND (no audit)', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Remove forged' });
    const result = await removeRecipePresetAction(recipe.id, 'preset_missing');
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await auditRowsFor('preset_missing')).toHaveLength(0);
  });
});

describe('reorderRecipePresetsAction', () => {
  it('lets KITCHEN reorder and audits the count only', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'K reorder' });
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C']) {
      const added = await addRecipePreset(h.db, h.org, recipe.id, {
        name,
        targetWeightGrams: 1,
      });
      if (added.status !== 'ok') throw new Error('seed failed');
      ids.push(added.row.id);
    }
    const result = await reorderRecipePresetsAction(recipe.id, {
      orderedPresetIds: [ids[2]!, ids[1]!, ids[0]!],
    });
    expect(result).toEqual({ ok: true, data: { count: 3 } });

    const audits = await auditRowsFor(recipe.id);
    const reorderRow = audits.find((a) => a.action === 'recipePreset.reorder');
    expect(reorderRow).toBeDefined();
    expect(reorderRow!.metadata).toEqual({ recipeId: recipe.id, count: 3 });
  });

  it('maps a stale set to RECIPE_PRESETS_CHANGED (no write/audit)', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Reorder stale' });
    const added = await addRecipePreset(h.db, h.org, recipe.id, {
      name: 'Only',
      targetWeightGrams: 1,
    });
    if (added.status !== 'ok') throw new Error('seed failed');
    const result = await reorderRecipePresetsAction(recipe.id, {
      orderedPresetIds: [added.row.id, 'preset_missing'],
    });
    expect(result).toEqual({ ok: false, code: 'RECIPE_PRESETS_CHANGED' });
  });

  it('rejects a duplicate-id payload with INVALID_INPUT', async () => {
    const recipe = await createRecipe(h.db, h.org, { name: 'Reorder dup' });
    const added = await addRecipePreset(h.db, h.org, recipe.id, {
      name: 'Only',
      targetWeightGrams: 1,
    });
    if (added.status !== 'ok') throw new Error('seed failed');
    const result = await reorderRecipePresetsAction(recipe.id, {
      orderedPresetIds: [added.row.id, added.row.id],
    });
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' });
  });
});
