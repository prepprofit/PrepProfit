import { NextResponse } from 'next/server';
import { getOrgId, getUserId, getUserRole, isManager } from '@/lib/auth';
import { aiExtractionMonthlyLimit } from '@/lib/entitlements';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/observability';
import { trackEvent } from '@/lib/analytics';
import { writeAuditEvent } from '@/lib/data/audit';
import { createImportJob } from '@/lib/data/import-jobs';
import { planRecipeImport } from '@/lib/data/import';
import {
  createExtractionAttempt,
  markAttemptSucceeded,
  markAttemptFailed,
  countReservedAttempts,
  lockMonthlyExtractionQuota,
  monthStartUtc,
} from '@/lib/data/ai-extraction';
import {
  getRecipeExtractor,
  RecipeExtractionError,
  RECIPE_EXTRACTION_MODEL,
  RECIPE_EXTRACTION_PROVIDER,
} from '@/lib/ai/recipe-extraction';
import { mapExtractedRecipe } from '@/lib/ai/map-extraction';
import { validateImageUpload } from '@/lib/ai/image';
import { IMPORT_JOB_TTL_MS } from '@/lib/validation/import';
import type { PhotoExtractionPreview } from '@/lib/ai/types';
import type { ActionErrorCode } from '@/lib/action-result';

// The Gemini SDK + neon-serverless Pool need Node; an upload is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * AI photo recipe extraction (Sprint 4.7, D3 Route Handler). A multipart image
 * upload → a staged `recipe_photo` job the user must review and confirm (CLAUDE.md:
 * AI output is untrusted, staged, human-confirmed — never an automatic write).
 *
 * Canonical order, ALL before the image is read: RBAC (manager-only, 403) → rate
 * limit (`aiExtraction`, 429) → image validation (415/413/400) → monthly usage cap
 * (402, the only entitlement check — AI is universal, metered by quota). Then: a
 * `pending` attempt is
 * written, the provider is called OUTSIDE any DB transaction (so a slow network call
 * never holds a tx open), the result is validated + mapped, and on success a job is
 * staged + the attempt flipped to `succeeded` + `ai.extract` audited — all org-scoped
 * (RULE #1, `withOrg`/RLS). A failure records a `failed` attempt and stages nothing;
 * the image bytes are discarded either way (ephemeral, D5).
 */
function fail(code: ActionErrorCode, status: number): NextResponse {
  return NextResponse.json({ code }, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await isManager())) return fail('FORBIDDEN', 403);

  const organizationId = await getOrgId();
  const userId = await getUserId();

  const limit = await enforceRateLimit(getDb(), 'aiExtraction', `${organizationId}:${userId}`);
  if (!limit.allowed) return fail('RATE_LIMITED', 429);

  // Read the multipart body and validate the image from its BYTES (not the declared
  // mime). Anything not a JPEG/PNG/WebP — including a renamed PDF — is rejected here.
  let bytes: Buffer;
  let mimeType: string;
  try {
    const form = await req.formData();
    const image = form.get('image');
    if (!(image instanceof File) || image.size === 0) return fail('INVALID_INPUT', 400);
    bytes = Buffer.from(await image.arrayBuffer());
    const valid = validateImageUpload(bytes, image.type);
    if (!valid.ok) return fail('INVALID_INPUT', valid.reason === 'TOO_LARGE' ? 413 : 415);
    mimeType = valid.mime;
  } catch {
    return fail('INVALID_INPUT', 400);
  }

  // Monthly usage cap (D4), race-safe (F-02): a (org, month) advisory lock serializes
  // the check, and the count includes still-in-flight `pending` reservations as well
  // as `succeeded` attempts — so concurrent uploads count toward the limit and the
  // cap can no longer overshoot. The pending attempt is created in the same tx (and
  // under the same lock) so the check and the reservation commit together.
  const { limit: monthlyLimit } = await aiExtractionMonthlyLimit();
  const now = new Date();
  const monthStart = monthStartUtc(now);
  const gate = await withOrg(organizationId, async (tx) => {
    await lockMonthlyExtractionQuota(tx, organizationId, monthStart);
    const used = await countReservedAttempts(tx, organizationId, monthStart, now);
    if (used >= monthlyLimit) return { capped: true as const };
    const attempt = await createExtractionAttempt(tx, organizationId, {
      actorUserId: userId,
      provider: RECIPE_EXTRACTION_PROVIDER,
      model: RECIPE_EXTRACTION_MODEL,
      imageCount: 1,
    });
    return { capped: false as const, attemptId: attempt.id };
  });
  if (gate.capped) return fail('USAGE_LIMIT_REACHED', 402);
  const attemptId = gate.attemptId;

  const role = await getUserRole();
  const actor = { userId, role, requestId: crypto.randomUUID() };

  // Provider call OUTSIDE any DB transaction. Untrusted output is validated inside
  // the extractor (strict Zod) before it returns.
  let extraction;
  try {
    extraction = await getRecipeExtractor().extract({ imageBytes: bytes, mimeType });
  } catch (err) {
    const eventId = logError({ action: 'recipePhotoExtract', orgId: organizationId }, err);
    await withOrg(organizationId, async (tx) => {
      await markAttemptFailed(tx, organizationId, attemptId, {
        errorCode: 'AI_EXTRACTION_FAILED',
      });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.extractFailed',
        entityType: 'aiExtractionAttempt',
        entityId: attemptId,
        metadata: {
          provider: 'google',
          reason: err instanceof RecipeExtractionError ? 'provider' : 'unexpected',
          eventId,
        },
      });
    });
    return fail('AI_EXTRACTION_FAILED', 502);
  }

  // Pure mapping (no DB): extracted recipe → draft + issues + quality flags.
  const mapped = mapExtractedRecipe(extraction.recipe);

  try {
    const preview = await withOrg(organizationId, async (tx): Promise<PhotoExtractionPreview> => {
      // Reuse the 4.6 planner: ingredient resolution (exact/fuzzy/new, never an
      // auto-link), org duplicate-recipe detection, and the staged payload.
      const plan = await planRecipeImport(tx, organizationId, mapped.recipes, mapped.issues);
      const job = await createImportJob(tx, organizationId, {
        actorUserId: userId,
        entity: 'recipe_photo',
        format: 'photo',
        sourceFilename: null,
        rowCount: plan.counts.importable,
        normalizedRows: plan.payload,
        issues: plan.issues,
        idempotencyKey: null,
        expiresAt: new Date(Date.now() + IMPORT_JOB_TTL_MS),
      });
      await markAttemptSucceeded(tx, organizationId, attemptId, {
        importJobId: job.id,
        inputTokens: extraction.usage.inputTokens,
        outputTokens: extraction.usage.outputTokens,
        costMicros: null,
        qualityFlags: mapped.qualityFlags,
      });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.extract',
        entityType: 'importJob',
        entityId: job.id,
        // COUNTS + provider metadata only — never the recipe text or image.
        metadata: {
          provider: extraction.provider,
          model: extraction.model,
          imageCount: 1,
          inputTokens: extraction.usage.inputTokens,
          outputTokens: extraction.usage.outputTokens,
          importable: plan.counts.importable,
          skipped: plan.counts.skipped,
          issues: plan.issues.length,
          qualityFlags: mapped.qualityFlags.length,
        },
      });
      return {
        jobId: job.id,
        counts: plan.counts,
        issues: plan.issues,
        recipePayload: plan.payload,
        qualityFlags: mapped.qualityFlags,
      };
    });
    // Product analytics (Sprint 5c): post-success, PII-free (counts only).
    await trackEvent({
      event: 'recipe_photo_extracted',
      orgId: organizationId,
      properties: { importable: preview.counts.importable },
    });
    return NextResponse.json(preview, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const eventId = logError({ action: 'recipePhotoStage', orgId: organizationId }, err);
    await withOrg(organizationId, (tx) =>
      markAttemptFailed(tx, organizationId, attemptId, { errorCode: 'AI_EXTRACTION_FAILED' }),
    ).catch(() => undefined);
    return NextResponse.json({ code: 'UNEXPECTED', eventId }, { status: 500 });
  }
}
