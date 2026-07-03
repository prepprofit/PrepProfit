import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { recipes, ingredients, aiExtractionAttempts } from '@/lib/db/schema';
import { createRecipe } from '@/lib/data/recipes';
import { createIngredient } from '@/lib/data/ingredients';
import {
  createExtractionAttempt,
  markAttemptFailed,
  markAttemptSucceeded,
} from '@/lib/data/ai-extraction';
import {
  hasActiveIngredient,
  hasSucceededPhotoExtraction,
  readActivationSnapshot,
} from '@/lib/data/activation';

/**
 * Data-layer tests for the Flows activation snapshot (flows-onboarding plan §4). Proves
 * the snapshot is org-scoped, soft-delete-aware, and LIFETIME (not monthly) for photo
 * extraction, so the Flows onboarding checklist stays honest across months and orgs.
 */

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

/** Insert a succeeded extraction directly with an explicit createdAt (for month tests). */
async function insertSucceededExtraction(org: string, createdAt: Date) {
  await db.insert(aiExtractionAttempts).values({
    organizationId: org,
    actorUserId: 'u',
    provider: 'google',
    model: 'gemini-2.5-flash',
    status: 'succeeded',
    createdAt,
  });
}

describe('getActivationSnapshot read model', () => {
  it('returns zero/false for a fresh org', async () => {
    const snap = await runInOrg(db, 'org_fresh', (tx) =>
      readActivationSnapshot(tx, 'org_fresh'),
    );
    expect(snap).toEqual({
      recipeCount: 0,
      hasIngredient: false,
      hasRunPhotoExtraction: false,
    });
  });

  it('counts only active, non-trashed recipes', async () => {
    const org = 'org_recipes';
    await runInOrg(db, org, (tx) => createRecipe(tx, org, { name: 'Soup' }));
    const trashed = await runInOrg(db, org, (tx) =>
      createRecipe(tx, org, { name: 'Old Stew' }),
    );
    // Soft-delete the second recipe (Trash pattern: deleted_at set).
    await db
      .update(recipes)
      .set({ deletedAt: new Date() })
      .where(eq(recipes.id, trashed.id));

    const snap = await runInOrg(db, org, (tx) => readActivationSnapshot(tx, org));
    expect(snap.recipeCount).toBe(1);
  });

  it('hasIngredient ignores soft-deleted ingredients', async () => {
    const org = 'org_ing';
    const ing = await runInOrg(db, org, (tx) =>
      createIngredient(tx, org, { name: 'Salt' }),
    );
    expect(
      await runInOrg(db, org, (tx) => hasActiveIngredient(tx, org)),
    ).toBe(true);

    await db
      .update(ingredients)
      .set({ deletedAt: new Date() })
      .where(eq(ingredients.id, ing.id));
    expect(
      await runInOrg(db, org, (tx) => hasActiveIngredient(tx, org)),
    ).toBe(false);
  });

  it('hasRunPhotoExtraction is true for a historical (previous-month) succeeded attempt', async () => {
    const org = 'org_photo_old';
    await insertSucceededExtraction(org, new Date('2020-01-15T10:00:00Z'));
    expect(
      await runInOrg(db, org, (tx) => hasSucceededPhotoExtraction(tx, org)),
    ).toBe(true);
    const snap = await runInOrg(db, org, (tx) => readActivationSnapshot(tx, org));
    expect(snap.hasRunPhotoExtraction).toBe(true);
  });

  it('failed and pending extraction attempts do not count', async () => {
    const org = 'org_photo_none';
    const failed = await runInOrg(db, org, (tx) =>
      createExtractionAttempt(tx, org, {
        actorUserId: 'u',
        provider: 'google',
        model: 'gemini-2.5-flash',
        imageCount: 1,
      }),
    );
    await runInOrg(db, org, (tx) =>
      markAttemptFailed(tx, org, failed.id, { errorCode: 'AI_EXTRACTION_FAILED' }),
    );
    // A still-pending attempt (never marked succeeded).
    await runInOrg(db, org, (tx) =>
      createExtractionAttempt(tx, org, {
        actorUserId: 'u',
        provider: 'google',
        model: 'gemini-2.5-flash',
        imageCount: 1,
      }),
    );
    expect(
      await runInOrg(db, org, (tx) => hasSucceededPhotoExtraction(tx, org)),
    ).toBe(false);

    // Flipping one to succeeded now makes it true (sanity on the same org).
    const ok = await runInOrg(db, org, (tx) =>
      createExtractionAttempt(tx, org, {
        actorUserId: 'u',
        provider: 'google',
        model: 'gemini-2.5-flash',
        imageCount: 1,
      }),
    );
    await runInOrg(db, org, (tx) =>
      markAttemptSucceeded(tx, org, ok.id, {
        importJobId: null,
        inputTokens: null,
        outputTokens: null,
        costMicros: null,
        qualityFlags: [],
      }),
    );
    expect(
      await runInOrg(db, org, (tx) => hasSucceededPhotoExtraction(tx, org)),
    ).toBe(true);
  });

  it("rows from another org never affect the snapshot", async () => {
    const org = 'org_iso_a';
    const other = 'org_iso_b';
    // Populate the OTHER org with everything.
    await runInOrg(db, other, (tx) => createRecipe(tx, other, { name: 'B Recipe' }));
    await runInOrg(db, other, (tx) => createIngredient(tx, other, { name: 'B Salt' }));
    await insertSucceededExtraction(other, new Date());

    const snap = await runInOrg(db, org, (tx) => readActivationSnapshot(tx, org));
    expect(snap).toEqual({
      recipeCount: 0,
      hasIngredient: false,
      hasRunPhotoExtraction: false,
    });
  });
});
