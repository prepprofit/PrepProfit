import { NextResponse } from 'next/server';
import { getOrgId, getUserId, getUserRole, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/observability';
import { writeAuditEvent } from '@/lib/data/audit';
import { createImportJob } from '@/lib/data/import-jobs';
import { planRecipeImport } from '@/lib/data/import';
import { getExtractionAttempt, linkAttemptToImportJob } from '@/lib/data/ai-extraction';
import { normalizePhotoDraftForImport } from '@/lib/ai/photo-draft';
import { parseQuantityText } from '@/lib/units/quantity';
import { stagePhotoDraftSchema, type StagePhotoDraftInput } from '@/lib/ai/photo-draft-schema';
import { IMPORT_JOB_TTL_MS } from '@/lib/validation/import';
import type { PhotoDraftLine, PhotoExtractionDraft, PhotoExtractionPreview } from '@/lib/ai/types';
import type { ActionErrorCode } from '@/lib/action-result';

// neon-serverless Pool needs Node; staging is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stage an EDITED photo draft into a `recipe_photo` import job (improvement plan §4.2,
 * G2). This is the server trust boundary: the client-edited draft is UNTRUSTED input.
 * The endpoint validates it with Zod, RE-DERIVES every active line's resolvability
 * itself (ignoring the client's status/issues), blocks staging while any active line
 * is unresolved (needs_review), checks the extraction attempt belongs to this org and
 * has not already been staged, runs `planRecipeImport` under `withOrg`/RLS, creates
 * the job, and links it back to the attempt. The existing `confirmImportAction` then
 * applies it after the mandatory human confirm — unchanged.
 *
 * Canonical order: RBAC (manager-only, 403) → rate limit (`import`, 429) → Zod
 * (400) → server re-validation of lines (400) → `withOrg` (attempt ownership 404,
 * plan, stage, link) — never an automatic write.
 */
function fail(code: ActionErrorCode, status: number): NextResponse {
  return NextResponse.json({ code }, { status });
}

/** A concurrent stage already linked this attempt — roll the tx back (no orphan job). */
class AlreadyStagedError extends Error {}

/**
 * The server's trusted numeric quantity for an edited line: re-parse the written text
 * (fractions included) rather than trusting any client number, falling back to the
 * client value only when there is no text. Mirrors extraction (§5.4).
 */
function stageQuantityValue(line: StagePhotoDraftInput['recipe']['lines'][number]): number | null {
  if (line.quantityText != null && line.quantityText.trim() !== '') {
    const parsed = parseQuantityText(line.quantityText);
    if ('value' in parsed) return parsed.value;
  }
  return line.quantityValue ?? null;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await isManager())) return fail('FORBIDDEN', 403);

  const organizationId = await getOrgId();
  const userId = await getUserId();

  const limit = await enforceRateLimit(getDb(), 'import', `${organizationId}:${userId}`);
  if (!limit.allowed) return fail('RATE_LIMITED', 429);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('INVALID_INPUT', 400);
  }
  const parsed = stagePhotoDraftSchema.safeParse(body);
  if (!parsed.success) return fail('INVALID_INPUT', 400);
  const input = parsed.data;

  // Server-authoritative draft: honor the user's `ignored` removals, but force every
  // other line to be re-derived from its own data — never trust the client's status.
  const lines: PhotoDraftLine[] = input.recipe.lines.map((l) => ({
    ...l,
    quantityValue: stageQuantityValue(l),
    status: l.status === 'ignored' ? 'ignored' : 'ready',
    issues: [],
  }));
  const draft: PhotoExtractionDraft = {
    attemptId: input.attemptId,
    recipe: {
      name: input.recipe.name,
      yieldPortions: input.recipe.yieldPortions,
      preparationNotes: input.recipe.preparationNotes,
      lines,
    },
    qualityFlags: [],
    usage: { provider: '', model: '' },
  };

  // Re-canonicalize: any active line that cannot become canonical data surfaces as an
  // issue → staging is blocked (the client disables Stage; the server is the authority).
  const normalized = normalizePhotoDraftForImport(draft);
  if (normalized.issues.length > 0) return fail('INVALID_INPUT', 400);
  if ((normalized.recipes[0]?.lines.length ?? 0) === 0) return fail('INVALID_INPUT', 400);

  const role = await getUserRole();
  const actor = { userId, role, requestId: crypto.randomUUID() };

  try {
    const result = await withOrg(organizationId, async (tx) => {
      const attempt = await getExtractionAttempt(tx, organizationId, input.attemptId);
      // Ownership + lifecycle: this org's attempt, provider-successful, not yet staged.
      if (!attempt || attempt.status !== 'succeeded' || attempt.importJobId !== null) {
        return { kind: 'not_found' as const };
      }

      const plan = await planRecipeImport(tx, organizationId, normalized.recipes, []);
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

      // Atomic guard: only links if still unstaged; a lost race rolls the job back.
      const linked = await linkAttemptToImportJob(tx, organizationId, input.attemptId, job.id);
      if (!linked) throw new AlreadyStagedError();

      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.stage',
        entityType: 'importJob',
        entityId: job.id,
        // COUNTS + ids only — never the recipe text (G6).
        metadata: {
          attemptId: input.attemptId,
          lines: normalized.recipes[0]?.lines.length ?? 0,
          importable: plan.counts.importable,
          skipped: plan.counts.skipped,
          issues: plan.issues.length,
        },
      });

      const preview: PhotoExtractionPreview = {
        jobId: job.id,
        counts: plan.counts,
        issues: plan.issues,
        recipePayload: plan.payload,
        qualityFlags: attempt.qualityFlags ?? [],
      };
      return { kind: 'ok' as const, preview };
    });

    if (result.kind === 'not_found') return fail('NOT_FOUND', 404);
    return NextResponse.json(result.preview, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof AlreadyStagedError) return fail('NOT_FOUND', 409);
    const eventId = logError({ action: 'recipePhotoStage', orgId: organizationId }, err);
    return NextResponse.json({ code: 'UNEXPECTED', eventId }, { status: 500 });
  }
}
