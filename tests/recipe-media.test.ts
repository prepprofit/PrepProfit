import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import { auditLog, recipes, recipeMedia } from '@/lib/db/schema';
import {
  createPendingRecipeMedia,
  confirmRecipeMedia,
  softDeleteRecipeMedia,
} from '@/lib/data/recipe-media';
import type { RecipeMediaStorage } from '@/lib/media/recipe-media-storage';
import type { AuditActor } from '@/lib/data/audit';

const ORG = 'org_media';
const OTHER_ORG = 'org_media_other';

const actor: AuditActor = {
  userId: 'user_m1',
  role: 'manager',
  requestId: 'req-media-test',
};

/** In-memory bucket standing in for the private blob store. */
function memoryStorage(): RecipeMediaStorage & {
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async createUploadUrl(key) {
      return { url: `mem://upload/${key}`, expiresAt: new Date() };
    },
    async createDownloadUrl(key) {
      return `mem://download/${key}`;
    },
    async readHead(key, maxBytes) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { bytes: bytes.subarray(0, maxBytes), totalSize: bytes.byteLength };
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

let client: PGlite;
let db: TenantDb;
let recipeId: string;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
  const [recipe] = await db
    .insert(recipes)
    .values({ organizationId: ORG, name: 'Cake', yieldPortions: 8 })
    .returning();
  recipeId = recipe!.id;
});

afterAll(async () => {
  await client.close();
});

describe('recipe media lifecycle', () => {
  it('creates a pending row with a server-built key (no filename input)', async () => {
    const result = await runInOrg(db, ORG, (tx) =>
      createPendingRecipeMedia(
        tx,
        ORG,
        recipeId,
        { kind: 'image', mimeType: 'image/png' },
        actor,
      ),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.media.status).toBe('pending');
    expect(result.storageKey).toBe(
      `org/${ORG}/recipes/${recipeId}/${result.media.id}`,
    );
    expect(result.media.uploadedBy).toBe('user_m1');
  });

  it('refuses a missing or cross-org recipe', async () => {
    const missing = await runInOrg(db, ORG, (tx) =>
      createPendingRecipeMedia(
        tx,
        ORG,
        'nope',
        { kind: 'image', mimeType: 'image/png' },
        actor,
      ),
    );
    expect(missing).toEqual({ ok: false, reason: 'recipe_not_found' });
    const crossOrg = await runInOrg(db, OTHER_ORG, (tx) =>
      createPendingRecipeMedia(
        tx,
        OTHER_ORG,
        recipeId,
        { kind: 'image', mimeType: 'image/png' },
        actor,
      ),
    );
    expect(crossOrg).toEqual({ ok: false, reason: 'recipe_not_found' });
  });

  it('confirm validates REAL bytes → ready, with sniffed dims + audit', async () => {
    const storage = memoryStorage();
    const pending = await runInOrg(db, ORG, (tx) =>
      createPendingRecipeMedia(
        tx,
        ORG,
        recipeId,
        { kind: 'image', mimeType: 'image/jpeg' }, // client lied about MIME
        actor,
      ),
    );
    if (!pending.ok) throw new Error('expected ok');
    storage.objects.set(pending.storageKey, pngBytes(320, 200));

    const confirmed = await runInOrg(db, ORG, (tx) =>
      confirmRecipeMedia(tx, ORG, recipeId, pending.media.id, storage, actor),
    );
    if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
    expect(confirmed.media.status).toBe('ready');
    // The sniffed type replaced the declared one.
    expect(confirmed.media.mimeType).toBe('image/png');
    expect(confirmed.media.width).toBe(320);
    expect(confirmed.media.height).toBe(200);
    expect(confirmed.media.byteSize).toBe(24);

    const audit = await runInOrg(db, ORG, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.organizationId, ORG),
            eq(auditLog.action, 'recipe.mediaUpload'),
          ),
        ),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.entityId).toBe(pending.media.id);

    // Re-confirming is not allowed (not pending anymore).
    const again = await runInOrg(db, ORG, (tx) =>
      confirmRecipeMedia(tx, ORG, recipeId, pending.media.id, storage, actor),
    );
    expect(again).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('confirm rejects garbage bytes → rejected + audit', async () => {
    const storage = memoryStorage();
    const pending = await runInOrg(db, ORG, (tx) =>
      createPendingRecipeMedia(
        tx,
        ORG,
        recipeId,
        { kind: 'image', mimeType: 'image/png' },
        actor,
      ),
    );
    if (!pending.ok) throw new Error('expected ok');
    storage.objects.set(pending.storageKey, new Uint8Array([1, 2, 3, 4]));

    const confirmed = await runInOrg(db, ORG, (tx) =>
      confirmRecipeMedia(tx, ORG, recipeId, pending.media.id, storage, actor),
    );
    expect(confirmed).toEqual({
      ok: false,
      reason: 'invalid_media',
      detail: 'unsupported_type',
    });
    const [row] = await runInOrg(db, ORG, (tx) =>
      tx
        .select({ status: recipeMedia.status })
        .from(recipeMedia)
        .where(eq(recipeMedia.id, pending.media.id)),
    );
    expect(row!.status).toBe('rejected');
  });

  it('confirm reports a never-uploaded object', async () => {
    const storage = memoryStorage();
    const pending = await runInOrg(db, ORG, (tx) =>
      createPendingRecipeMedia(
        tx,
        ORG,
        recipeId,
        { kind: 'video', mimeType: 'video/mp4' },
        actor,
      ),
    );
    if (!pending.ok) throw new Error('expected ok');
    const confirmed = await runInOrg(db, ORG, (tx) =>
      confirmRecipeMedia(tx, ORG, recipeId, pending.media.id, storage, actor),
    );
    expect(confirmed).toEqual({ ok: false, reason: 'object_missing' });
  });

  it('soft delete flips status, clears a cover reference and audits', async () => {
    const storage = memoryStorage();
    const pending = await runInOrg(db, ORG, (tx) =>
      createPendingRecipeMedia(
        tx,
        ORG,
        recipeId,
        { kind: 'image', mimeType: 'image/png' },
        actor,
      ),
    );
    if (!pending.ok) throw new Error('expected ok');
    storage.objects.set(pending.storageKey, pngBytes(10, 10));
    await runInOrg(db, ORG, (tx) =>
      confirmRecipeMedia(tx, ORG, recipeId, pending.media.id, storage, actor),
    );
    await runInOrg(db, ORG, (tx) =>
      tx
        .update(recipes)
        .set({ coverMediaId: pending.media.id })
        .where(eq(recipes.id, recipeId)),
    );

    const deleted = await runInOrg(db, ORG, (tx) =>
      softDeleteRecipeMedia(tx, ORG, recipeId, pending.media.id, actor),
    );
    if (!deleted.ok) throw new Error('expected ok');
    expect(deleted.storageKey).toBe(pending.storageKey);

    const [after] = await runInOrg(db, ORG, (tx) =>
      tx
        .select({ status: recipeMedia.status, deletedAt: recipeMedia.deletedAt })
        .from(recipeMedia)
        .where(eq(recipeMedia.id, pending.media.id)),
    );
    expect(after!.status).toBe('deleted');
    expect(after!.deletedAt).not.toBeNull();
    const [recipeRow] = await runInOrg(db, ORG, (tx) =>
      tx
        .select({ coverMediaId: recipes.coverMediaId })
        .from(recipes)
        .where(eq(recipes.id, recipeId)),
    );
    expect(recipeRow!.coverMediaId).toBeNull();

    // Cross-org delete finds nothing (RLS + explicit scoping).
    const crossOrg = await runInOrg(db, OTHER_ORG, (tx) =>
      softDeleteRecipeMedia(tx, OTHER_ORG, recipeId, pending.media.id, actor),
    );
    expect(crossOrg).toEqual({ ok: false, reason: 'not_found' });
  });
});
