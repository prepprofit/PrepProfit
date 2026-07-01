import { NextResponse } from 'next/server';
import { getOrgId, getUserId, getUserRole, isManager } from '@/lib/auth';
import { supplierInvoiceMonthlyLimit } from '@/lib/entitlements';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/observability';
import { writeAuditEvent } from '@/lib/data/audit';
import {
  createOperationAttempt,
  markOperationSucceeded,
  markOperationFailed,
  countReservedOperations,
  lockMonthlyOperationQuota,
  monthStartUtc,
} from '@/lib/data/ai-operation-attempts';
import {
  getInvoiceExtractor,
  InvoiceExtractionError,
  INVOICE_EXTRACTION_MODEL,
  INVOICE_EXTRACTION_PROVIDER,
} from '@/lib/ai/invoice-extraction';
import { computeCostMicros } from '@/lib/ai/pricing';
import { mapInvoiceExtractionToDraft } from '@/lib/ai/invoice-draft';
import { createInvoiceImport } from '@/lib/data/supplier-invoice-imports';
import { MAX_DOCUMENT_BYTES, validateDocumentUpload } from '@/lib/ai/document-upload';
import {
  declaredBodyExceeds,
  MULTIPART_OVERHEAD_BYTES,
} from '@/lib/validation/request-size';
import type { ActionErrorCode } from '@/lib/action-result';

// The Gemini SDK + neon-serverless Pool need Node; an upload is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The Gemini vision call is a slow round-trip (plus a short retry budget); raise the
// function ceiling to 60s (Hobby max) so the platform never kills it mid-extraction.
export const maxDuration = 60;

const FEATURE = 'supplier_invoice_extraction' as const;

/**
 * Supplier Invoice Reader upload (Sprint 2, AI margin roadmap). A multipart image/PDF
 * upload → the model extraction becomes a `draft` supplier invoice import the manager
 * reviews (nothing is applied here; apply — which records PENDING price observations —
 * is a separate manager action).
 *
 * Canonical order, ALL before the document is read: RBAC (manager-only, 403) → rate
 * limit (`supplierInvoiceExtract`, 429) → document validation (415/413/400) → monthly
 * usage cap (402). Then a `pending` attempt is written, the provider is called OUTSIDE
 * any DB transaction, the result is validated + mapped, and the draft import is created
 * with the attempt flipped to `succeeded` + `ai.invoiceExtract` audited — all org-scoped
 * (RULE #1, `withOrg`/RLS). A failure records a `failed` attempt; the bytes are
 * discarded either way (ephemeral).
 */
function fail(code: ActionErrorCode, status: number): NextResponse {
  return NextResponse.json({ code }, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await isManager())) return fail('FORBIDDEN', 403);

  const organizationId = await getOrgId();
  const userId = await getUserId();

  const limit = await enforceRateLimit(
    getDb(),
    'supplierInvoiceExtract',
    `${organizationId}:${userId}`,
  );
  if (!limit.allowed) return fail('RATE_LIMITED', 429);

  // Fast-fail an honestly-declared oversized body BEFORE buffering it (audit F3);
  // the post-parse byte validator below stays the authoritative limit.
  if (declaredBodyExceeds(req, MAX_DOCUMENT_BYTES + MULTIPART_OVERHEAD_BYTES)) {
    return fail('INVALID_INPUT', 413);
  }

  // Read the multipart body and validate the document from its BYTES (image or PDF).
  let bytes: Buffer;
  let mimeType: string;
  try {
    const form = await req.formData();
    const doc = form.get('document');
    if (!(doc instanceof File) || doc.size === 0) return fail('INVALID_INPUT', 400);
    bytes = Buffer.from(await doc.arrayBuffer());
    const valid = validateDocumentUpload(bytes, doc.type);
    if (!valid.ok) return fail('INVALID_INPUT', valid.reason === 'TOO_LARGE' ? 413 : 415);
    mimeType = valid.mime;
  } catch {
    return fail('INVALID_INPUT', 400);
  }

  // Monthly usage cap (race-safe): a (org, feature, month) advisory lock serializes the
  // check; the count includes in-flight `pending` reservations, and the pending attempt
  // is created in the same tx + lock so the check and reservation commit together.
  const { limit: monthlyLimit } = await supplierInvoiceMonthlyLimit();
  const now = new Date();
  const monthStart = monthStartUtc(now);
  const gate = await withOrg(organizationId, async (tx) => {
    await lockMonthlyOperationQuota(tx, organizationId, FEATURE, monthStart);
    const used = await countReservedOperations(tx, organizationId, FEATURE, monthStart, now);
    if (used >= monthlyLimit) return { capped: true as const };
    const attempt = await createOperationAttempt(tx, organizationId, {
      actorUserId: userId,
      feature: FEATURE,
      provider: INVOICE_EXTRACTION_PROVIDER,
      model: INVOICE_EXTRACTION_MODEL,
    });
    return { capped: false as const, attemptId: attempt.id };
  });
  if (gate.capped) return fail('USAGE_LIMIT_REACHED', 402);
  const attemptId = gate.attemptId;

  const role = await getUserRole();
  const actor = { userId, role, requestId: crypto.randomUUID() };

  // Provider call OUTSIDE any DB transaction. Untrusted output is validated inside the
  // extractor (strict Zod) before it returns.
  let extraction;
  try {
    extraction = await getInvoiceExtractor().extract({ documentBytes: bytes, mimeType });
  } catch (err) {
    const busy = err instanceof InvoiceExtractionError && err.retryable;
    const code = busy ? 'AI_INVOICE_BUSY' : 'AI_INVOICE_FAILED';
    const eventId = logError({ action: 'supplierInvoiceExtract', orgId: organizationId }, err);
    await withOrg(organizationId, async (tx) => {
      await markOperationFailed(tx, organizationId, attemptId, { errorCode: code });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.invoiceExtractFailed',
        entityType: 'aiOperationAttempt',
        entityId: attemptId,
        metadata: {
          provider: INVOICE_EXTRACTION_PROVIDER,
          reason: busy ? 'overloaded' : err instanceof InvoiceExtractionError ? 'provider' : 'unexpected',
          eventId,
        },
      });
    });
    return fail(code, busy ? 503 : 502);
  }

  // Pure mapping (no DB): validated extraction → an editable draft (no silent loss).
  const draft = mapInvoiceExtractionToDraft(extraction.invoice);

  try {
    const created = await withOrg(organizationId, async (tx) => {
      const result = await createInvoiceImport(tx, organizationId, {
        actorUserId: userId,
        aiAttemptId: attemptId,
        draft,
      });
      await markOperationSucceeded(tx, organizationId, attemptId, {
        inputTokens: extraction.usage.inputTokens,
        outputTokens: extraction.usage.outputTokens,
        costMicros: computeCostMicros({
          model: extraction.model,
          inputTokens: extraction.usage.inputTokens,
          outputTokens: extraction.usage.outputTokens,
        }),
        qualityFlags: draft.qualityFlags,
        resultType: 'supplier_invoice_import',
        resultId: result.importId,
      });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.invoiceExtract',
        entityType: 'supplierInvoiceImport',
        entityId: result.importId,
        // COUNTS + provider metadata only — never the document, raw line text, or PII.
        metadata: {
          provider: extraction.provider,
          model: extraction.model,
          inputTokens: extraction.usage.inputTokens,
          outputTokens: extraction.usage.outputTokens,
          lines: result.total,
          ready: result.ready,
          needsReview: result.needsReview,
          qualityFlags: draft.qualityFlags.length,
          attempts: extraction.attempts ?? 1,
        },
      });
      return result;
    });
    return NextResponse.json(created, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const eventId = logError({ action: 'supplierInvoiceExtract', orgId: organizationId }, err);
    await withOrg(organizationId, (tx) =>
      markOperationFailed(tx, organizationId, attemptId, { errorCode: 'AI_INVOICE_FAILED' }),
    ).catch(() => undefined);
    return NextResponse.json({ code: 'UNEXPECTED', eventId }, { status: 500 });
  }
}
