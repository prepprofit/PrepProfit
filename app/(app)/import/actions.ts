'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { ingredients } from '@/lib/db/schema';
import { isForeignKeyViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import { trackEvent } from '@/lib/analytics';
import { enforceRateLimit } from '@/lib/rate-limit';
import { assertPlanLimit } from '@/lib/entitlements';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { countActiveRecipes } from '@/lib/data/recipes';
import {
  createImportJob,
  lockImportJob,
  markImportJobCommitted,
  markImportJobExpired,
} from '@/lib/data/import-jobs';
import {
  planIngredientImport,
  planTransactionImport,
  planRecipeImport,
  applyIngredientRecords,
  applyTransactionRecords,
  applyRecipeImport,
  buildResolvedChoices,
  type ImportPlan,
  type RecipeImportPlan,
} from '@/lib/data/import';
import {
  readImportMatrix,
  parseIngredients,
  parseTransactions,
  parseRecipes,
} from '@/lib/import/parse';
import {
  importParamsSchema,
  confirmImportSchema,
  importIngredientRecordSchema,
  importTransactionRecordSchema,
  importRecipePayloadSchema,
  MAX_IMPORT_BYTES,
  IMPORT_JOB_TTL_MS,
} from '@/lib/validation/import';
import {
  RECIPE_IMPORT_ENTITIES,
  type ImportEntity,
  type ImportFormat,
  type FileImportFormat,
  type ImportRecord,
  type ImportRecipePayload,
  type ImportRowIssue,
} from '@/lib/import/types';
import type { ActionErrorCode } from '@/lib/action-result';

/**
 * Server Actions for deterministic import (Sprint 4.5). Canonical order on BOTH
 * actions: RBAC (manager-only, FORBIDDEN before any data access) → rate-limit
 * (import bucket, on the un-scoped infra table) → Zod → `withOrg` (RLS) →
 * audit-after-success. Import is a Starter-module convenience (ingredients /
 * transactions), so it is NOT feature-gated; it is manager-only like the data it
 * creates.
 *
 * STAGED + deterministic (CLAUDE.md): preview parses + validates server-side and
 * stores a job; confirm sends back ONLY the job id — never rows — so a forged
 * payload can neither alter records nor reach another org (RLS hides the job).
 */

/** Max importable records echoed back for the preview grid (display only). */
const PREVIEW_SAMPLE_LIMIT = 50;

export type ImportPreview = {
  jobId: string;
  entity: ImportEntity;
  format: ImportFormat;
  filename: string | null;
  counts: { total: number; importable: number; skipped: number; invalid: number };
  issues: ImportRowIssue[];
  /** Flat sample records for ingredients/transactions (empty for recipes). */
  sample: ImportRecord[];
  /** Recipe-only staged payload (records + per-name resolutions) for the UI. */
  recipePayload?: ImportRecipePayload;
};

export type ImportActionState =
  | { ok: true; phase: 'preview'; preview: ImportPreview }
  | { ok: true; phase: 'committed'; entity: ImportEntity; created: number; alreadyCommitted: boolean }
  | { ok: false; code: ActionErrorCode };

const fail = (code: ActionErrorCode): ImportActionState => ({ ok: false, code });

/** Allowed file extension per selected format (rejects `.xlsm`, etc.). */
const EXT: Record<FileImportFormat, string> = { csv: '.csv', xlsx: '.xlsx' };

/* -------------------------------------------------------------------------- */
/* Preview (dry-run)                                                          */
/* -------------------------------------------------------------------------- */

export async function previewImportAction(
  _prev: ImportActionState | null,
  formData: FormData,
): Promise<ImportActionState> {
  if (!(await isManager())) return fail('FORBIDDEN');

  const organizationId = await getOrgId();
  const userId = await getUserId();

  const limit = await enforceRateLimit(getDb(), 'import', `${organizationId}:${userId}`);
  if (!limit.allowed) return fail('RATE_LIMITED');

  const params = importParamsSchema.safeParse({
    entity: formData.get('entity'),
    format: formData.get('format'),
  });
  if (!params.success) return fail('INVALID_INPUT');
  const { entity, format } = params.data;

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return fail('INVALID_INPUT');
  if (file.size > MAX_IMPORT_BYTES) return fail('INVALID_INPUT');
  if (!file.name.toLowerCase().endsWith(EXT[format])) return fail('INVALID_INPUT');

  const actor = await auditActor();
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_IMPORT_BYTES) return fail('INVALID_INPUT');

    const matrix = await readImportMatrix(format, bytes);
    const filename = file.name.slice(0, 255);

    // Parse (pure) and plan (DB), branched by entity so the row types stay
    // concrete; a file-level parse error bails before any DB work.
    if (entity === 'ingredients') {
      const parsed = parseIngredients(matrix);
      if (!parsed.ok) return fail('INVALID_INPUT');
      const preview = await stageJob(organizationId, userId, actor, entity, format, filename, (tx) =>
        planIngredientImport(tx, organizationId, parsed.rows),
      );
      return { ok: true, phase: 'preview', preview };
    }

    if (entity === 'recipes') {
      const parsed = parseRecipes(matrix);
      if (!parsed.ok) return fail('INVALID_INPUT');
      const preview = await stageRecipeJob(organizationId, userId, actor, format, filename, (tx) =>
        planRecipeImport(tx, organizationId, parsed.recipes, parsed.issues),
      );
      return { ok: true, phase: 'preview', preview };
    }

    const parsed = parseTransactions(matrix);
    if (!parsed.ok) return fail('INVALID_INPUT');
    const preview = await stageJob(organizationId, userId, actor, entity, format, filename, (tx) =>
      planTransactionImport(tx, organizationId, parsed.rows),
    );
    return { ok: true, phase: 'preview', preview };
  } catch (err) {
    return unexpected('previewImportAction', err, organizationId) as ImportActionState;
  }
}

/**
 * Shared staging step: run the entity's plan inside `withOrg` (RLS), persist the
 * job, audit the preview, and shape the display payload. The plan callback fixes
 * the entity (and thus the record type), so no casts are needed.
 */
async function stageJob(
  organizationId: string,
  userId: string,
  actor: Awaited<ReturnType<typeof auditActor>>,
  entity: ImportEntity,
  format: ImportFormat,
  filename: string,
  plan: (tx: Parameters<Parameters<typeof withOrg>[1]>[0]) => Promise<ImportPlan>,
): Promise<ImportPreview> {
  return withOrg(organizationId, async (tx) => {
    const result = await plan(tx);
    const job = await createImportJob(tx, organizationId, {
      actorUserId: userId,
      entity,
      format,
      sourceFilename: filename,
      rowCount: result.records.length,
      normalizedRows: result.records,
      issues: result.issues,
      idempotencyKey: null,
      expiresAt: new Date(Date.now() + IMPORT_JOB_TTL_MS),
    });
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'import.preview',
      entityType: 'importJob',
      entityId: job.id,
      metadata: { entity, format, ...result.counts },
    });
    return {
      jobId: job.id,
      entity,
      format,
      filename: job.sourceFilename,
      counts: result.counts,
      issues: result.issues,
      sample: result.records.slice(0, PREVIEW_SAMPLE_LIMIT),
    };
  });
}

/**
 * Recipe staging: like `stageJob`, but stores the recipe PAYLOAD (records +
 * per-name resolutions) and reports `importable` as the recipe count. The UI uses
 * `recipePayload` to render the ingredient-resolution panel before confirm.
 */
async function stageRecipeJob(
  organizationId: string,
  userId: string,
  actor: Awaited<ReturnType<typeof auditActor>>,
  format: ImportFormat,
  filename: string,
  plan: (tx: Parameters<Parameters<typeof withOrg>[1]>[0]) => Promise<RecipeImportPlan>,
): Promise<ImportPreview> {
  return withOrg(organizationId, async (tx) => {
    const result = await plan(tx);
    const job = await createImportJob(tx, organizationId, {
      actorUserId: userId,
      entity: 'recipes',
      format,
      sourceFilename: filename,
      rowCount: result.counts.importable,
      normalizedRows: result.payload,
      issues: result.issues,
      idempotencyKey: null,
      expiresAt: new Date(Date.now() + IMPORT_JOB_TTL_MS),
    });
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'import.preview',
      entityType: 'importJob',
      entityId: job.id,
      metadata: { entity: 'recipes', format, ...result.counts },
    });
    return {
      jobId: job.id,
      entity: 'recipes' as const,
      format,
      filename: job.sourceFilename,
      counts: result.counts,
      issues: result.issues,
      sample: [],
      recipePayload: result.payload,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Confirm                                                                    */
/* -------------------------------------------------------------------------- */

export async function confirmImportAction(
  _prev: ImportActionState | null,
  formData: FormData,
): Promise<ImportActionState> {
  if (!(await isManager())) return fail('FORBIDDEN');

  const organizationId = await getOrgId();
  const userId = await getUserId();

  const limit = await enforceRateLimit(getDb(), 'import', `${organizationId}:${userId}`);
  if (!limit.allowed) return fail('RATE_LIMITED');

  // Recipe confirm also carries the resolution choices as a JSON array; other
  // entities omit it. The choices are re-validated server-side against the job's
  // stored suggestions (never trusted blindly).
  const rawResolutions = formData.get('resolutions');
  let resolutions: unknown;
  if (typeof rawResolutions === 'string' && rawResolutions.length > 0) {
    try {
      resolutions = JSON.parse(rawResolutions);
    } catch {
      return fail('INVALID_INPUT');
    }
  }

  const parsed = confirmImportSchema.safeParse({
    jobId: formData.get('jobId'),
    resolutions,
  });
  if (!parsed.success) return fail('INVALID_INPUT');
  const { jobId } = parsed.data;
  const clientResolutions = parsed.data.resolutions ?? [];

  const actor = await auditActor();
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const job = await lockImportJob(tx, organizationId, jobId);
      if (!job) return { kind: 'not_found' as const };

      // Idempotent: a second confirm of an already-applied job is a no-op success.
      if (job.status === 'committed') {
        return { kind: 'already' as const, entity: job.entity, created: job.rowCount };
      }
      if (job.status !== 'parsed') return { kind: 'not_found' as const };
      if (job.expiresAt.getTime() < Date.now()) {
        await markImportJobExpired(tx, organizationId, jobId);
        return { kind: 'expired' as const };
      }

      // Defense-in-depth: never trust the stored JSON blindly — re-validate with
      // Zod, scoped to the job's entity, before inserting.
      const stored = job.normalizedRows ?? [];
      let created = 0;
      if (job.entity === 'ingredients') {
        const valid = z.array(importIngredientRecordSchema).safeParse(stored);
        if (!valid.success) return { kind: 'invalid' as const };
        created = await applyIngredientRecords(tx, organizationId, valid.data);
      } else if (job.entity === 'transactions') {
        const valid = z.array(importTransactionRecordSchema).safeParse(stored);
        if (!valid.success) return { kind: 'invalid' as const };
        created = await applyTransactionRecords(tx, organizationId, valid.data);
      } else if (RECIPE_IMPORT_ENTITIES.includes(job.entity)) {
        // Recipes (spreadsheet) and recipe_photo (AI extraction) BOTH stage an
        // ImportRecipePayload and confirm identically. Validate the stored payload,
        // the client's resolution choices
        // (D8), re-check that every linked id is an ACTIVE org ingredient, enforce
        // the recipe plan cap all-or-nothing (D7), then apply.
        const valid = importRecipePayloadSchema.safeParse(stored);
        if (!valid.success) return { kind: 'invalid' as const };
        const payload = valid.data as ImportRecipePayload;

        const built = buildResolvedChoices(payload.resolutions, clientResolutions);
        if (!built.ok) return { kind: 'invalid' as const };

        if (built.linkIds.length > 0) {
          const active = await tx
            .select({ id: ingredients.id })
            .from(ingredients)
            .where(
              and(
                eq(ingredients.organizationId, organizationId),
                isNull(ingredients.deletedAt),
                inArray(ingredients.id, built.linkIds),
              ),
            );
          const activeIds = new Set(active.map((r) => r.id));
          if (built.linkIds.some((id) => !activeIds.has(id))) {
            return { kind: 'invalid' as const };
          }
        }

        const toCreate = payload.recipes.length;
        if (toCreate > 0) {
          const current = await countActiveRecipes(tx, organizationId);
          // assertPlanLimit checks "room for one more"; the LAST recipe added must
          // still fit, so probe at (current + toCreate - 1).
          const { allowed } = await assertPlanLimit('recipes', current + toCreate - 1);
          if (!allowed) return { kind: 'plan_limit' as const };
        }

        created = await applyRecipeImport(tx, organizationId, payload, built.choices);
      } else {
        // Defense: an unrecognized entity is never applied.
        return { kind: 'invalid' as const };
      }

      await markImportJobCommitted(tx, organizationId, jobId);
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'import.commit',
        entityType: 'importJob',
        entityId: jobId,
        metadata: { entity: job.entity, created },
      });
      return { kind: 'ok' as const, entity: job.entity, created };
    });

    if (outcome.kind === 'not_found') return fail('NOT_FOUND');
    if (outcome.kind === 'expired') return fail('IMPORT_EXPIRED');
    if (outcome.kind === 'invalid') return fail('INVALID_INPUT');
    if (outcome.kind === 'plan_limit') return fail('PLAN_LIMIT_REACHED');

    revalidateForEntity(outcome.entity);
    // Product analytics (Sprint 5c): post-success, PII-free (entity + count only).
    if (outcome.kind === 'ok') {
      await trackEvent({
        event: 'import_committed',
        orgId: organizationId,
        properties: { entity: outcome.entity, created: outcome.created },
      });
    }
    return {
      ok: true,
      phase: 'committed',
      entity: outcome.entity,
      created: outcome.created,
      alreadyCommitted: outcome.kind === 'already',
    };
  } catch (err) {
    // A category that vanished between preview and confirm → composite FK
    // violation; the whole tx rolled back (all-or-nothing), so re-preview.
    if (isForeignKeyViolation(err)) return fail('NOT_FOUND');
    return unexpected('confirmImportAction', err, organizationId) as ImportActionState;
  }
}

function revalidateForEntity(entity: ImportEntity): void {
  revalidatePath('/import');
  if (entity === 'ingredients') {
    revalidatePath('/ingredients');
    revalidatePath('/inventory');
  } else if (entity === 'recipes' || entity === 'recipe_photo') {
    // Recipe import (spreadsheet or photo) may also create new (unpriced) ingredients.
    revalidatePath('/recipes');
    revalidatePath('/ingredients');
  } else {
    revalidatePath('/transactions');
    revalidatePath('/financials');
    revalidatePath('/dashboard');
  }
}
