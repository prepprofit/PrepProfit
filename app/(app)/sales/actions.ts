'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { isUniqueViolation } from '@/lib/db/errors';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError, unexpected } from '@/lib/observability';
import { dailyCloseSummaryMonthlyLimit, requireFeature } from '@/lib/entitlements';
import { getOrgSettings } from '@/lib/data/org-settings';
import { MovementError } from '@/lib/data/inventory';
import {
  createSale,
  deleteSale,
  postSale,
  updateSale,
  voidSale,
  type SaleLineInput,
} from '@/lib/data/sales';
import { loadDailyCloseInsights } from '@/lib/data/daily-close-insights';
import {
  createOperationAttempt,
  markOperationSucceeded,
  markOperationFailed,
  countReservedOperations,
  lockMonthlyOperationQuota,
  monthStartUtc,
} from '@/lib/data/ai-operation-attempts';
import {
  getDailyCloseSummarizer,
  buildDailyCloseSummaryFacts,
  DailyCloseSummaryError,
  DAILY_CLOSE_SUMMARY_MODEL,
  DAILY_CLOSE_SUMMARY_PROVIDER,
  type DailyCloseSummary,
} from '@/lib/ai/daily-close-summary';
import { computeCostMicros } from '@/lib/ai/pricing';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  createSaleSchema,
  saleStateSchema,
  updateSaleSchema,
} from '@/lib/validation/sales';
import type { ActionResult, ActionErrorCode } from '@/lib/action-result';
import type { Sale } from '@/lib/db/schema';

/**
 * Server Actions for daily-close Sales (Sprint 12a). Sales are FINANCIAL →
 * MANAGER-ONLY, and gated by the `invoices` plan feature (D4 — Pro+). Canonical order
 * per action: RBAC (`isManager()`) → entitlement (`requireFeature('invoices')`) → Zod
 * → `withOrg`(mutation + audit in one tx) → targeted revalidate. Kitchen gets
 * `FORBIDDEN` before any data access; a manager on a plan without the feature gets
 * `UPGRADE_REQUIRED` before data.
 *
 * Audit metadata is ids / counts / status / stockMoved / movement+reversal counts /
 * transaction id only — NEVER the gross/net/tax amounts or any item name (CLAUDE.md).
 */

function revalidateSales(id?: string): void {
  revalidatePath('/sales');
  if (id) revalidatePath(`/sales/${id}`);
  // Posting/voiding writes/soft-deletes the income transaction → refresh financials.
  revalidatePath('/transactions');
  revalidatePath('/financials');
  revalidatePath('/dashboard');
}

/** RBAC → entitlement gate shared by every sales action. Null = allowed. */
async function guard(): Promise<ActionErrorCode | null> {
  if (!(await isManager())) return 'FORBIDDEN';
  return requireFeature('invoices');
}

/** Map an F1 batch `MovementError` thrown out of `withOrg` to a stable code. */
function movementErrorCode(reason: MovementError['reason']): ActionErrorCode {
  switch (reason) {
    case 'insufficient_stock':
      return 'INSUFFICIENT_STOCK';
    case 'idempotency_conflict':
      return 'IDEMPOTENCY_CONFLICT';
    case 'not_found':
      // A consumed ingredient disappeared/trashed before the ledger lock.
      return 'SALE_INCOMPLETE';
  }
}

export async function createSaleAction(
  input: unknown,
): Promise<ActionResult<Sale>> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = createSaleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const lines = parsed.data.lines as SaleLineInput[];

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await createSale(
        tx,
        organizationId,
        { saleDate: parsed.data.saleDate, note: parsed.data.note ?? null },
        lines,
      );
      if (result.status !== 'ok') return result.status;
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'sale.create',
        entityType: 'sale',
        entityId: result.sale.id,
        metadata: { lineCount: lines.length },
      });
      return result.sale;
    });

    if (outcome === 'date_taken') return { ok: false, code: 'SALE_DATE_TAKEN' };
    if (outcome === 'invalid_source') return { ok: false, code: 'SALE_INCOMPLETE' };
    revalidateSales(outcome.id);
    return { ok: true, data: outcome };
  } catch (err) {
    // Race backstop: two concurrent creates for the same date — the partial unique
    // index rejects the loser.
    if (isUniqueViolation(err)) return { ok: false, code: 'SALE_DATE_TAKEN' };
    return unexpected('createSaleAction', err, organizationId);
  }
}

export async function updateSaleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Sale>> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = updateSaleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const lines = parsed.data.lines as SaleLineInput[];
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await updateSale(
        tx,
        organizationId,
        id,
        expectedUpdatedAt,
        { saleDate: parsed.data.saleDate, note: parsed.data.note ?? null },
        lines,
      );
      if (result.status !== 'ok') return result.status;
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'sale.update',
        entityType: 'sale',
        entityId: id,
        metadata: { lineCount: lines.length },
      });
      return result.sale;
    });

    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'stale') return { ok: false, code: 'SALE_STALE' };
    if (outcome === 'not_editable') return { ok: false, code: 'SALE_NOT_EDITABLE' };
    if (outcome === 'invalid_source') return { ok: false, code: 'SALE_INCOMPLETE' };
    if (outcome === 'date_taken') return { ok: false, code: 'SALE_DATE_TAKEN' };
    revalidateSales(id);
    return { ok: true, data: outcome };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'SALE_DATE_TAKEN' };
    return unexpected('updateSaleAction', err, organizationId);
  }
}

export async function deleteSaleAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = saleStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await deleteSale(tx, organizationId, id, expectedUpdatedAt);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'sale.delete',
      entityType: 'sale',
      entityId: id,
    });
    return 'done' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'SALE_STALE' };
  if (outcome === 'not_editable') return { ok: false, code: 'SALE_NOT_EDITABLE' };
  revalidateSales(id);
  return { ok: true, data: undefined };
}

/**
 * `draft → posted`. Writes the single protected income row (F5) + idempotent stock
 * consumption (F1). The `MovementError` (hard stock floor / conflict) is caught
 * OUTSIDE `withOrg`, after rollback. A refused/stale/incomplete op — and an
 * already-posted no-op — does NOT audit.
 */
export async function postSaleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Sale>> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = saleStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await postSale(tx, organizationId, id, expectedUpdatedAt);
      if (result.status !== 'ok') return result.status;
      if (!result.alreadyPosted) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'sale.post',
          entityType: 'sale',
          entityId: id,
          metadata: {
            lineCount: result.lineCount,
            ingredientCount: result.ingredientCount,
            stockMoved: result.stockMoved,
            movementCount: result.movementCount,
            transactionId: result.transactionId,
          },
        });
      }
      return result.sale;
    });

    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'stale') return { ok: false, code: 'SALE_STALE' };
    if (outcome === 'not_postable') {
      return { ok: false, code: 'INVALID_STATUS_TRANSITION' };
    }
    if (outcome === 'incomplete') return { ok: false, code: 'SALE_INCOMPLETE' };
    if (outcome === 'tax_rate_required') {
      return { ok: false, code: 'SALES_TAX_RATE_REQUIRED' };
    }
    if (outcome === 'idempotency_conflict') {
      return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    }
    revalidateSales(id);
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    return unexpected('postSaleAction', err, organizationId);
  }
}

/**
 * `posted → void`. Soft-deletes the income row (F5) + reverses the booked OUT
 * movements (F1) and retains the row as history. An already-void no-op does NOT audit.
 */
export async function voidSaleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Sale>> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = saleStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await voidSale(tx, organizationId, id, expectedUpdatedAt);
      if (result.status !== 'ok') return result.status;
      if (!result.alreadyVoided) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'sale.void',
          entityType: 'sale',
          entityId: id,
          metadata: { reversalCount: result.reversalCount },
        });
      }
      return result.sale;
    });

    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'stale') return { ok: false, code: 'SALE_STALE' };
    if (outcome === 'not_voidable') {
      return { ok: false, code: 'INVALID_STATUS_TRANSITION' };
    }
    revalidateSales(id);
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    return unexpected('voidSaleAction', err, organizationId);
  }
}

const SUMMARY_FEATURE = 'daily_close_summary' as const;

export type DailyCloseSummaryResult = { summary: DailyCloseSummary };

/**
 * Summarize a POSTED daily close with AI (Sprint 6, AI margin roadmap). Manager-only +
 * `invoices`-gated (the same guard as the rest of the sales module). Order (all before any
 * provider call): RBAC/entitlement → rate limit → load the deterministic insights
 * (NOT_FOUND when the sale is missing/draft/void/cross-org, so a non-postable close never
 * reaches the provider) → monthly usage cap (race-safe). The provider is then called
 * OUTSIDE any DB transaction and its output validated inside the summarizer; the attempt is
 * flipped to `succeeded` with usage/cost and audited. A provider failure records a `failed`
 * attempt and returns a stable code while the deterministic close figures stay visible.
 *
 * There is NO cache table (Sprint 6 ships no migration): every call spends one quota slot,
 * so the client keeps the returned summary and only re-summarizes on an explicit action.
 */
export async function summarizeDailyCloseAction(
  saleId: string,
): Promise<ActionResult<DailyCloseSummaryResult>> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };
  if (typeof saleId !== 'string' || saleId.length === 0) {
    return { ok: false, code: 'INVALID_INPUT' };
  }

  const organizationId = await getOrgId();
  const userId = await getUserId();

  // Burst/abuse control before any org work (the monthly cap is the quota control).
  const limit = await enforceRateLimit(getDb(), 'aiDailyClose', `${organizationId}:${userId}`);
  if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

  // A summary can only exist for a real POSTED close: the loader returns null for a
  // draft/void/cross-org/missing sale, so those never reach the provider.
  const [insights, settings] = await Promise.all([
    withOrg(organizationId, (tx) => loadDailyCloseInsights(tx, organizationId, saleId)),
    getOrgSettings(),
  ]);
  if (!insights) return { ok: false, code: 'NOT_FOUND' };

  // Monthly usage cap (race-safe): a (org, feature, month) advisory lock serializes the
  // check; the pending attempt is created in the same tx + lock so check and reservation
  // commit together.
  const { limit: monthlyLimit } = await dailyCloseSummaryMonthlyLimit();
  const now = new Date();
  const monthStart = monthStartUtc(now);
  const gate = await withOrg(organizationId, async (tx) => {
    await lockMonthlyOperationQuota(tx, organizationId, SUMMARY_FEATURE, monthStart);
    const used = await countReservedOperations(tx, organizationId, SUMMARY_FEATURE, monthStart, now);
    if (used >= monthlyLimit) return { capped: true as const };
    const attempt = await createOperationAttempt(tx, organizationId, {
      actorUserId: userId,
      feature: SUMMARY_FEATURE,
      provider: DAILY_CLOSE_SUMMARY_PROVIDER,
      model: DAILY_CLOSE_SUMMARY_MODEL,
    });
    return { capped: false as const, attemptId: attempt.id };
  });
  if (gate.capped) return { ok: false, code: 'USAGE_LIMIT_REACHED' };
  const attemptId = gate.attemptId;

  const actor = await auditActor();
  const facts = buildDailyCloseSummaryFacts(insights, settings.currency);

  // Provider call OUTSIDE any DB transaction. Output is validated inside the summarizer.
  let result;
  try {
    result = await getDailyCloseSummarizer().summarize(facts);
  } catch (err) {
    const busy = err instanceof DailyCloseSummaryError && err.retryable;
    const code = busy ? 'AI_SUMMARY_BUSY' : 'AI_SUMMARY_FAILED';
    const eventId = logError({ action: 'summarizeDailyClose', orgId: organizationId }, err);
    await withOrg(organizationId, async (tx) => {
      await markOperationFailed(tx, organizationId, attemptId, { errorCode: code });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.dailyCloseSummaryFailed',
        entityType: 'aiOperationAttempt',
        entityId: attemptId,
        metadata: {
          provider: DAILY_CLOSE_SUMMARY_PROVIDER,
          reason: busy
            ? 'overloaded'
            : err instanceof DailyCloseSummaryError
              ? 'provider'
              : 'unexpected',
          eventId,
        },
      });
    }).catch(() => undefined);
    return { ok: false, code };
  }

  try {
    await withOrg(organizationId, async (tx) => {
      await markOperationSucceeded(tx, organizationId, attemptId, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costMicros: computeCostMicros({
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        }),
        qualityFlags: [],
        resultType: 'sale',
        resultId: saleId,
      });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.dailyCloseSummary',
        entityType: 'sale',
        entityId: saleId,
        // Descriptors + provider metadata only — never amounts, item names or raw prose.
        metadata: {
          provider: result.provider,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          riskLevel: result.summary.riskLevel,
          attempts: result.attempts ?? 1,
        },
      });
    });
    return { ok: true, data: { summary: result.summary } };
  } catch (err) {
    await withOrg(organizationId, (tx) =>
      markOperationFailed(tx, organizationId, attemptId, { errorCode: 'AI_SUMMARY_FAILED' }),
    ).catch(() => undefined);
    return unexpected('summarizeDailyCloseAction', err, organizationId);
  }
}
