import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgId, getUserId, getUserRole } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/observability';
import { confirmRecipeMedia } from '@/lib/data/recipe-media';
import { getRecipeMediaStorage } from '@/lib/media/recipe-media-storage';
import type { ActionErrorCode } from '@/lib/action-result';

// neon-serverless Pool + bucket reads need Node; never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Confirm an uploaded recipe-media object (plan §5, §6.4): re-read the REAL
 * leading bytes from the private bucket, validate magic bytes / dimensions /
 * size server-side (the client's declared MIME is untrusted), then flip the
 * row `pending → ready`. Validation failure flips to `rejected` (422) and the
 * sweeper removes the object. Audited inside the same transaction.
 */
function fail(code: ActionErrorCode, status: number): NextResponse {
  return NextResponse.json({ code }, { status });
}

const bodySchema = z.object({ mediaId: z.string().min(1).max(64) });

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

  const role = await getUserRole();
  const actor = { userId, role, requestId: crypto.randomUUID() };
  const storage = getRecipeMediaStorage();

  try {
    const result = await withOrg(organizationId, (tx) =>
      confirmRecipeMedia(
        tx,
        organizationId,
        recipeId,
        parsed.data.mediaId,
        storage,
        actor,
      ),
    );

    if (!result.ok) {
      if (result.reason === 'invalid_media') {
        return NextResponse.json(
          { code: 'INVALID_INPUT', detail: result.detail },
          { status: 422 },
        );
      }
      if (result.reason === 'not_pending') return fail('INVALID_INPUT', 409);
      return fail('NOT_FOUND', 404); // not_found | object_missing
    }

    const m = result.media;
    // Short signed GET so the uploader can preview immediately (private store).
    const url = await storage.createDownloadUrl(m.storageKey, {
      expiresMs: 15 * 60 * 1000,
    });
    return NextResponse.json(
      {
        mediaId: m.id,
        url,
        kind: m.kind,
        mimeType: m.mimeType,
        byteSize: m.byteSize,
        width: m.width,
        height: m.height,
        status: m.status,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    const eventId = logError(
      { action: 'recipeMediaConfirm', orgId: organizationId },
      err,
    );
    return NextResponse.json({ code: 'UNEXPECTED', eventId }, { status: 500 });
  }
}
