import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgId, getUserId, getUserRole } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/observability';
import {
  createPendingRecipeMedia,
  maxBytesForKind,
  uploadUrlTtlMs,
} from '@/lib/data/recipe-media';
import { getRecipeMediaStorage } from '@/lib/media/recipe-media-storage';
import {
  RECIPE_MEDIA_IMAGE_MIME_TYPES,
  RECIPE_MEDIA_VIDEO_MIME_TYPES,
} from '@/lib/media/validate';
import type { ActionErrorCode } from '@/lib/action-result';

// neon-serverless Pool + Blob signing need Node; never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Issue a short-lived signed PUT URL for one recipe-media object (plan §5,
 * §6.4). The storage key is built SERVER-SIDE from org/recipe/media ids — the
 * client sends only kind + MIME type; its filename never reaches the bucket.
 * Media is OPERATIONAL (method photos/videos), so both roles may upload, same
 * as method editing. Order: auth → rate limit → Zod → withOrg (recipe
 * ownership + pending row) → signed URL.
 */
function fail(code: ActionErrorCode, status: number): NextResponse {
  return NextResponse.json({ code }, { status });
}

const bodySchema = z
  .object({
    kind: z.enum(['image', 'video']),
    mimeType: z.string(),
  })
  .refine((b) =>
    b.kind === 'image'
      ? (RECIPE_MEDIA_IMAGE_MIME_TYPES as readonly string[]).includes(b.mimeType)
      : (RECIPE_MEDIA_VIDEO_MIME_TYPES as readonly string[]).includes(b.mimeType),
  );

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const organizationId = await getOrgId();
  const userId = await getUserId();
  const { id: recipeId } = await ctx.params;

  const limit = await enforceRateLimit(
    getDb(),
    'recipeMedia',
    `${organizationId}:${userId}`,
  );
  if (!limit.allowed) return fail('RATE_LIMITED', 429);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('INVALID_INPUT', 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return fail('INVALID_INPUT', 400);
  const input = parsed.data;

  const role = await getUserRole();
  const actor = { userId, role, requestId: crypto.randomUUID() };

  try {
    const result = await withOrg(organizationId, (tx) =>
      createPendingRecipeMedia(tx, organizationId, recipeId, input, actor),
    );
    if (!result.ok) return fail('NOT_FOUND', 404);

    const maxBytes = maxBytesForKind(input.kind);
    const upload = await getRecipeMediaStorage().createUploadUrl(
      result.storageKey,
      {
        contentType: input.mimeType,
        maxBytes,
        expiresMs: uploadUrlTtlMs(),
      },
    );

    return NextResponse.json(
      {
        mediaId: result.media.id,
        uploadUrl: upload.url,
        expiresAt: upload.expiresAt.toISOString(),
        maxBytes,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    const eventId = logError(
      { action: 'recipeMediaUploadUrl', orgId: organizationId },
      err,
    );
    return NextResponse.json({ code: 'UNEXPECTED', eventId }, { status: 500 });
  }
}
