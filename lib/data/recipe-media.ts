import { and, eq, isNull } from 'drizzle-orm';
import { recipes, recipeMedia, type RecipeMedia } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import {
  recipeMediaKey,
  type RecipeMediaStorage,
} from '@/lib/media/recipe-media-storage';
import {
  validateRecipeMediaBytes,
  RECIPE_MEDIA_IMAGE_MAX_BYTES,
  RECIPE_MEDIA_VIDEO_MAX_BYTES,
  RECIPE_MEDIA_SNIFF_BYTES,
  type MediaValidationResult,
} from '@/lib/media/validate';

/**
 * Recipe media lifecycle facade (Fase 3, plan §6.4). MUST run inside `withOrg`.
 * Flow: `createPendingRecipeMedia` reserves a row + server-built storage key →
 * the route hands the client a short signed PUT URL → `confirmRecipeMedia`
 * re-reads the object's real bytes, validates them and flips the row to
 * `ready` (or `rejected`). Deletion is soft in the DB; the bucket object is
 * removed asynchronously and idempotently (cron + purge hooks).
 */

const UPLOAD_URL_TTL_MS = 10 * 60 * 1000;

export type CreatePendingMediaResult =
  | { ok: true; media: RecipeMedia; storageKey: string }
  | { ok: false; reason: 'recipe_not_found' };

export async function createPendingRecipeMedia(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  input: { kind: 'image' | 'video'; mimeType: string },
  actor: AuditActor,
): Promise<CreatePendingMediaResult> {
  const [recipe] = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, recipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .limit(1);
  if (!recipe) return { ok: false, reason: 'recipe_not_found' };

  // Key needs the id, so the id is generated app-side (same UUID format as
  // the column default) and inserted explicitly.
  const mediaId = crypto.randomUUID();
  const storageKey = recipeMediaKey(organizationId, recipeId, mediaId);
  const [media] = await db
    .insert(recipeMedia)
    .values({
      id: mediaId,
      organizationId,
      recipeId,
      storageKey,
      kind: input.kind,
      mimeType: input.mimeType,
      status: 'pending',
      uploadedBy: actor.userId,
    })
    .returning();
  return { ok: true, media: media!, storageKey };
}

export function uploadUrlTtlMs(): number {
  return UPLOAD_URL_TTL_MS;
}

export function maxBytesForKind(kind: 'image' | 'video'): number {
  return kind === 'image'
    ? RECIPE_MEDIA_IMAGE_MAX_BYTES
    : RECIPE_MEDIA_VIDEO_MAX_BYTES;
}

export type ConfirmMediaResult =
  | { ok: true; media: RecipeMedia }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'object_missing' }
  | {
      ok: false;
      reason: 'invalid_media';
      detail: Extract<MediaValidationResult, { ok: false }>['reason'];
    };

/**
 * Validate the uploaded object's REAL bytes and flip pending → ready. A failed
 * validation marks the row `rejected` (the sweeper removes the object later)
 * and audits the rejection; success audits `recipe.mediaUpload`.
 */
export async function confirmRecipeMedia(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  mediaId: string,
  storage: RecipeMediaStorage,
  actor: AuditActor,
): Promise<ConfirmMediaResult> {
  const [row] = await db
    .select()
    .from(recipeMedia)
    .where(
      and(
        eq(recipeMedia.organizationId, organizationId),
        eq(recipeMedia.recipeId, recipeId),
        eq(recipeMedia.id, mediaId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };

  const head = await storage.readHead(row.storageKey, RECIPE_MEDIA_SNIFF_BYTES);
  if (!head) return { ok: false, reason: 'object_missing' };

  const validation = validateRecipeMediaBytes(
    head.bytes,
    head.totalSize,
    row.kind,
  );
  if (!validation.ok) {
    await db
      .update(recipeMedia)
      .set({ status: 'rejected' })
      .where(
        and(
          eq(recipeMedia.organizationId, organizationId),
          eq(recipeMedia.id, mediaId),
        ),
      );
    await writeAuditEvent(db, organizationId, actor, {
      action: 'recipe.mediaReject',
      entityType: 'recipeMedia',
      entityId: mediaId,
      metadata: { recipeId, kind: row.kind, reason: validation.reason },
    });
    return { ok: false, reason: 'invalid_media', detail: validation.reason };
  }

  const [updated] = await db
    .update(recipeMedia)
    .set({
      status: 'ready',
      // The REAL sniffed type/size replace the client-declared ones.
      mimeType: validation.mimeType,
      byteSize: head.totalSize,
      width: validation.kind === 'image' ? validation.width : null,
      height: validation.kind === 'image' ? validation.height : null,
    })
    .where(
      and(
        eq(recipeMedia.organizationId, organizationId),
        eq(recipeMedia.id, mediaId),
      ),
    )
    .returning();
  await writeAuditEvent(db, organizationId, actor, {
    action: 'recipe.mediaUpload',
    entityType: 'recipeMedia',
    entityId: mediaId,
    metadata: {
      recipeId,
      kind: validation.kind,
      mimeType: validation.mimeType,
      byteSize: head.totalSize,
    },
  });
  return { ok: true, media: updated! };
}

export type SoftDeleteMediaResult =
  | { ok: true; storageKey: string }
  | { ok: false; reason: 'not_found' };

/**
 * Soft delete: the row flips to `deleted` (links to steps/cover become dead
 * and are filtered by readers); the caller removes the bucket object AFTER
 * commit, idempotently. Also clears a cover reference pointing at this media.
 */
export async function softDeleteRecipeMedia(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
  mediaId: string,
  actor: AuditActor,
): Promise<SoftDeleteMediaResult> {
  const [row] = await db
    .update(recipeMedia)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(
      and(
        eq(recipeMedia.organizationId, organizationId),
        eq(recipeMedia.recipeId, recipeId),
        eq(recipeMedia.id, mediaId),
      ),
    )
    .returning({ storageKey: recipeMedia.storageKey });
  if (!row) return { ok: false, reason: 'not_found' };

  await db
    .update(recipes)
    .set({ coverMediaId: null })
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, recipeId),
        eq(recipes.coverMediaId, mediaId),
      ),
    );

  await writeAuditEvent(db, organizationId, actor, {
    action: 'recipe.mediaDelete',
    entityType: 'recipeMedia',
    entityId: mediaId,
    metadata: { recipeId },
  });
  return { ok: true, storageKey: row.storageKey };
}
