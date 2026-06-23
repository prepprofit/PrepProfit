'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { isUniqueViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import { trackEvent } from '@/lib/analytics';
import { enforceRateLimit } from '@/lib/rate-limit';
import { requireFeature } from '@/lib/entitlements';
import { MovementError } from '@/lib/data/inventory';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { getOrgSettingsRow } from '@/lib/data/org-settings';
import {
  createImportJob,
  lockImportJob,
  markImportJobCommitted,
  markImportJobExpired,
} from '@/lib/data/import-jobs';
import {
  planSalesImport,
  applySalesImport,
  SalesImportError,
} from '@/lib/data/sales-import';
import { readImportMatrix, parseSalesRows } from '@/lib/import/parse';
import {
  importParamsSchema,
  importSalesPayloadSchema,
  MAX_IMPORT_BYTES,
  IMPORT_JOB_TTL_MS,
} from '@/lib/validation/import';
import type { ImportSalesPayload } from '@/lib/import/types';
import type { ActionErrorCode } from '@/lib/action-result';
import type { ImportActionState } from './actions';

/**
 * Sales import Server Actions (Sprint 12b) — dedicated, NOT folded into the generic
 * import actions, because sales is the only file entity that is plan-GATED. Both
 * actions enforce the mandatory order: RBAC (`isManager()`, FORBIDDEN before any
 * work) → entitlement (`requireFeature('invoices')`, UPGRADE_REQUIRED before file
 * parsing / job read) → rate limit (import bucket) → Zod / file validation → `withOrg`
 * (RLS) → audit-after-success → revalidate.
 *
 * STAGED + deterministic (CLAUDE.md): preview parses + plans server-side and stores
 * an `ImportSalesPayload` job; confirm sends back ONLY the job id and applies the
 * importable closes through the 12a primitives (createSale → postSale), never
 * writing income transactions or inventory movements directly.
 */

const fail = (code: ActionErrorCode): ImportActionState => ({ ok: false, code });

/** Allowed file extension per selected format. */
const EXT = { csv: '.csv', xlsx: '.xlsx' } as const;

/** Shared RBAC → entitlement gate. Null = allowed. */
async function guard(): Promise<ActionErrorCode | null> {
  if (!(await isManager())) return 'FORBIDDEN';
  return requireFeature('invoices');
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

export async function previewSalesImportAction(
  _prev: ImportActionState | null,
  formData: FormData,
): Promise<ImportActionState> {
  const denied = await guard();
  if (denied) return fail(denied);

  const organizationId = await getOrgId();
  const userId = await getUserId();

  const limit = await enforceRateLimit(getDb(), 'import', `${organizationId}:${userId}`);
  if (!limit.allowed) return fail('RATE_LIMITED');

  const params = importParamsSchema.safeParse({
    entity: formData.get('entity'),
    format: formData.get('format'),
  });
  if (!params.success || params.data.entity !== 'sales') return fail('INVALID_INPUT');
  const { format } = params.data;

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

    const parsed = parseSalesRows(matrix);
    if (!parsed.ok) return fail('INVALID_INPUT');

    const outcome = await withOrg(organizationId, async (tx) => {
      const settings = await getOrgSettingsRow(tx, organizationId);
      // The post path REQUIRES a configured org rate even when rows carry explicit
      // rates (D6) — refuse before staging a job, so the manager fixes Settings first.
      if (settings?.defaultTaxRateBps == null) {
        return { kind: 'tax_required' as const };
      }

      const plan = await planSalesImport(tx, organizationId, parsed.rows, {
        defaultTaxRateBps: settings.defaultTaxRateBps,
        stockControlStartDate: settings.stockControlStartDate ?? null,
      });

      const job = await createImportJob(tx, organizationId, {
        actorUserId: userId,
        entity: 'sales',
        format,
        sourceFilename: filename,
        rowCount: plan.counts.importable,
        normalizedRows: plan.payload,
        issues: plan.issues,
        idempotencyKey: null,
        expiresAt: new Date(Date.now() + IMPORT_JOB_TTL_MS),
      });

      await writeAuditEvent(tx, organizationId, actor, {
        action: 'import.preview',
        entityType: 'importJob',
        entityId: job.id,
        metadata: {
          entity: 'sales',
          format,
          financialOnly: plan.financialOnly,
          ...plan.counts,
        },
      });

      return {
        kind: 'ok' as const,
        job,
        plan,
      };
    });

    if (outcome.kind === 'tax_required') return fail('SALES_TAX_RATE_REQUIRED');

    return {
      ok: true,
      phase: 'preview',
      preview: {
        jobId: outcome.job.id,
        entity: 'sales',
        format,
        filename: outcome.job.sourceFilename,
        counts: outcome.plan.counts,
        issues: outcome.plan.issues,
        sample: [],
        salesPreview: {
          closes: outcome.plan.payload.closes,
          financialOnly: outcome.plan.financialOnly,
        },
      },
    };
  } catch (err) {
    return unexpected('previewSalesImportAction', err, organizationId) as ImportActionState;
  }
}

/* -------------------------------------------------------------------------- */
/* Confirm                                                                    */
/* -------------------------------------------------------------------------- */

const confirmSchema = z.object({ jobId: z.string().min(1).max(60) });

export async function confirmSalesImportAction(
  _prev: ImportActionState | null,
  formData: FormData,
): Promise<ImportActionState> {
  const denied = await guard();
  if (denied) return fail(denied);

  const organizationId = await getOrgId();
  const userId = await getUserId();

  const limit = await enforceRateLimit(getDb(), 'import', `${organizationId}:${userId}`);
  if (!limit.allowed) return fail('RATE_LIMITED');

  const parsed = confirmSchema.safeParse({ jobId: formData.get('jobId') });
  if (!parsed.success) return fail('INVALID_INPUT');
  const { jobId } = parsed.data;

  const actor = await auditActor();
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const job = await lockImportJob(tx, organizationId, jobId);
      if (!job) return { kind: 'not_found' as const };

      // Idempotent: a second confirm of an already-applied job is a no-op success.
      if (job.status === 'committed') {
        return { kind: 'already' as const, created: job.rowCount };
      }
      if (job.status !== 'parsed') return { kind: 'not_found' as const };
      if (job.entity !== 'sales') return { kind: 'invalid' as const };
      if (job.expiresAt.getTime() < Date.now()) {
        await markImportJobExpired(tx, organizationId, jobId);
        return { kind: 'expired' as const };
      }

      // Defense-in-depth: never trust the stored JSON blindly — re-validate.
      const valid = importSalesPayloadSchema.safeParse(job.normalizedRows);
      if (!valid.success) return { kind: 'invalid' as const };
      const payload = valid.data as ImportSalesPayload;

      const result = await applySalesImport(tx, organizationId, actor, payload.closes);

      await markImportJobCommitted(tx, organizationId, jobId);
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'import.commit',
        entityType: 'importJob',
        entityId: jobId,
        metadata: {
          entity: 'sales',
          closesCreated: result.closesCreated,
          linesCreated: result.linesCreated,
          movementsCreated: result.movementsCreated,
          financialOnly: result.financialOnly,
        },
      });

      return { kind: 'ok' as const, created: result.closesCreated };
    });

    if (outcome.kind === 'not_found') return fail('NOT_FOUND');
    if (outcome.kind === 'expired') return fail('IMPORT_EXPIRED');
    if (outcome.kind === 'invalid') return fail('INVALID_INPUT');

    revalidate();
    if (outcome.kind === 'ok') {
      await trackEvent({
        event: 'import_committed',
        orgId: organizationId,
        properties: { entity: 'sales', created: outcome.created },
      });
    }
    return {
      ok: true,
      phase: 'committed',
      entity: 'sales',
      created: outcome.created,
      alreadyCommitted: outcome.kind === 'already',
    };
  } catch (err) {
    // Typed import error thrown after the first write → whole confirm rolled back
    // (job stays `parsed`); surface its stable code with the offending date.
    if (err instanceof SalesImportError) return fail(err.code);
    // A stock shortfall / idempotency conflict from `recordMovements`.
    if (err instanceof MovementError) {
      if (err.reason === 'insufficient_stock') return fail('INSUFFICIENT_STOCK');
      if (err.reason === 'idempotency_conflict') return fail('IDEMPOTENCY_CONFLICT');
      return fail('SALE_INCOMPLETE');
    }
    // Race: a concurrent manual/import close took a date between preview and confirm.
    if (isUniqueViolation(err)) return fail('SALE_DATE_TAKEN');
    return unexpected('confirmSalesImportAction', err, organizationId) as ImportActionState;
  }
}

function revalidate(): void {
  revalidatePath('/import');
  revalidatePath('/sales');
  revalidatePath('/transactions');
  revalidatePath('/financials');
  revalidatePath('/dashboard');
}
