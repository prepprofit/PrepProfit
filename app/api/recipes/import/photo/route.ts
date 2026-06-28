import { NextResponse } from 'next/server';
import { getOrgId, getUserId, getUserRole, isManager } from '@/lib/auth';
import { aiExtractionMonthlyLimit } from '@/lib/entitlements';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/observability';
import { trackEvent } from '@/lib/analytics';
import { writeAuditEvent } from '@/lib/data/audit';
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
import { computeCostMicros } from '@/lib/ai/pricing';
import { mapExtractionToPhotoDraft } from '@/lib/ai/photo-draft';
import { applySupplierPacks, isUnresolvedPackDescriptor } from '@/lib/ai/supplier-pack-resolve';
import { loadSupplierPacksByIngredientName } from '@/lib/data/ingredient-suppliers';
import { validateImageUpload } from '@/lib/ai/image';
import type { ActionErrorCode } from '@/lib/action-result';

// The Gemini SDK + neon-serverless Pool need Node; an upload is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Coarse, PII-free latency bucket for product analytics (improvement plan Phase 5 /
 * G6). A bucket label, never the raw millisecond figure, keeps the event a low-
 * cardinality dimension for the P95-extraction launch metric without exposing
 * anything about the user or their recipe.
 */
function latencyBucket(ms: number): string {
  if (ms < 2_000) return '<2s';
  if (ms < 5_000) return '2-5s';
  if (ms < 10_000) return '5-10s';
  if (ms < 20_000) return '10-20s';
  return '>=20s';
}

/**
 * AI photo recipe extraction (Sprint 4.7, improvement plan §4.1). A multipart image
 * upload → an EDITABLE `PhotoExtractionDraft` the user reviews and corrects in the
 * workbench; nothing is staged here (CLAUDE.md: AI output is untrusted; staging +
 * the mandatory confirm happen later, via the stage endpoint + `confirmImportAction`).
 *
 * Canonical order, ALL before the image is read: RBAC (manager-only, 403) → rate
 * limit (`aiExtraction`, 429) → image validation (415/413/400) → monthly usage cap
 * (402, the only entitlement check — AI is universal, metered by quota). Then: a
 * `pending` attempt is written, the provider is called OUTSIDE any DB transaction (so
 * a slow network call never holds a tx open), the result is validated + mapped to the
 * no-loss draft, the attempt is flipped to `succeeded` with NO job yet (its cost is
 * spent regardless, §4.3) + `ai.extract` audited — all org-scoped (RULE #1,
 * `withOrg`/RLS). A failure records a `failed` attempt; the image bytes are discarded
 * either way (ephemeral, D5).
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
  const extractStartedAt = Date.now();
  try {
    extraction = await getRecipeExtractor().extract({ imageBytes: bytes, mimeType });
  } catch (err) {
    // A transient provider overload (busy, survived retries) is reported distinctly
    // from an unusable-output failure: 503 + AI_EXTRACTION_BUSY tells the user to try
    // again shortly rather than wrongly blaming their photo. Both stage nothing.
    const busy = err instanceof RecipeExtractionError && err.retryable;
    const code = busy ? 'AI_EXTRACTION_BUSY' : 'AI_EXTRACTION_FAILED';
    const eventId = logError({ action: 'recipePhotoExtract', orgId: organizationId }, err);
    await withOrg(organizationId, async (tx) => {
      await markAttemptFailed(tx, organizationId, attemptId, { errorCode: code });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.extractFailed',
        entityType: 'aiExtractionAttempt',
        entityId: attemptId,
        metadata: {
          provider: 'google',
          reason: busy ? 'overloaded' : err instanceof RecipeExtractionError ? 'provider' : 'unexpected',
          eventId,
        },
      });
    });
    return fail(code, busy ? 503 : 502);
  }

  // Pure mapping (no DB): extracted recipe → a line-complete, EDITABLE draft. Every
  // line the model read is kept (ready / needs_review / ignored); nothing is staged
  // here. The user reviews + corrects the draft, then the separate stage endpoint
  // turns the edited draft into an import job (G1 no-loss; G2 server trust boundary).
  const draft = mapExtractionToPhotoDraft(extraction.recipe, {
    attemptId,
    provider: extraction.provider,
    model: extraction.model,
  });
  // Provider wall-clock for the §9.3 P95 launch metric. A non-PII count/label only.
  const extractLatencyMs = Date.now() - extractStartedAt;
  const retried = (extraction.attempts ?? 1) > 1;
  // Phase 6: only touch the supplier-pack table if some descriptor line could benefit
  // (the common case — a recipe in real units — skips the query entirely).
  const wantsPacks = draft.recipe.lines.some(
    (l) => l.status !== 'ignored' && isUnresolvedPackDescriptor(l),
  );

  try {
    const { draft: finalDraft, counts } = await withOrg(organizationId, async (tx) => {
      // Phase 6 supplier-pack inference: fill a descriptor line's pack size from the
      // org's own `ingredient_suppliers` data (`1 block butter` → 250 g) so the chef's
      // returned draft is already canonical. NEVER auto-prices (§6/§13) — it only
      // canonicalizes the recipe line's quantity; new ingredients still start at 0.
      const { lines, resolved: packsResolved } = wantsPacks
        ? applySupplierPacks(
            draft.recipe.lines,
            await loadSupplierPacksByIngredientName(tx, organizationId),
          )
        : { lines: draft.recipe.lines, resolved: 0 };
      const finalDraft = { ...draft, recipe: { ...draft.recipe, lines } };
      const counts = {
        total: lines.length,
        ready: lines.filter((l) => l.status === 'ready').length,
        needsReview: lines.filter((l) => l.status === 'needs_review').length,
        ignored: lines.filter((l) => l.status === 'ignored').length,
      };

      // Provider-successful: the attempt is `succeeded` now — its cost is spent, so it
      // counts toward the monthly cap even if the user abandons before staging (§4.3) —
      // but with NO import job yet. The draft is staged later (stage endpoint), which
      // links the job back to this attempt.
      await markAttemptSucceeded(tx, organizationId, attemptId, {
        importJobId: null,
        inputTokens: extraction.usage.inputTokens,
        outputTokens: extraction.usage.outputTokens,
        // Estimated provider spend (tokens × published Gemini price); null when the
        // model is unpriced or no usage was reported. Operator metadata, not tenant money.
        costMicros: computeCostMicros({
          model: extraction.model,
          inputTokens: extraction.usage.inputTokens,
          outputTokens: extraction.usage.outputTokens,
        }),
        qualityFlags: finalDraft.qualityFlags,
      });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.extract',
        entityType: 'aiExtractionAttempt',
        entityId: attemptId,
        // COUNTS + provider metadata only — never the recipe text or image (G6).
        metadata: {
          provider: extraction.provider,
          model: extraction.model,
          imageCount: 1,
          inputTokens: extraction.usage.inputTokens,
          outputTokens: extraction.usage.outputTokens,
          lines: counts.total,
          ready: counts.ready,
          needsReview: counts.needsReview,
          ignored: counts.ignored,
          packsResolved,
          qualityFlags: finalDraft.qualityFlags.length,
          latencyMs: extractLatencyMs,
          attempts: extraction.attempts ?? 1,
        },
      });
      return { draft: finalDraft, counts };
    });
    // Product analytics (Sprint 5c): post-success, PII-free — counts, flags, model,
    // and a coarse latency BUCKET (never the raw ms or any recipe/image content; G6).
    await trackEvent({
      event: 'recipe_photo_extracted',
      orgId: organizationId,
      properties: {
        lines: counts.total,
        needsReview: counts.needsReview,
        qualityFlags: finalDraft.qualityFlags.length,
        model: extraction.model,
        latencyBucket: latencyBucket(extractLatencyMs),
        retried,
      },
    });
    return NextResponse.json(finalDraft, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const eventId = logError({ action: 'recipePhotoExtract', orgId: organizationId }, err);
    await withOrg(organizationId, (tx) =>
      markAttemptFailed(tx, organizationId, attemptId, { errorCode: 'AI_EXTRACTION_FAILED' }),
    ).catch(() => undefined);
    return NextResponse.json({ code: 'UNEXPECTED', eventId }, { status: 500 });
  }
}
