'use server';

import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError, unexpected } from '@/lib/observability';
import { getOrgSettings } from '@/lib/data/org-settings';
import { weeklyCfoReportMonthlyLimit } from '@/lib/entitlements';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { loadCfoReport, defaultCfoWeekTo } from '@/lib/data/cfo-report';
import {
  createOperationAttempt,
  markOperationSucceeded,
  markOperationFailed,
  countReservedOperations,
  lockMonthlyOperationQuota,
  monthStartUtc,
} from '@/lib/data/ai-operation-attempts';
import {
  getCfoReportSummarizer,
  buildCfoReportFacts,
  CfoReportError,
  CFO_REPORT_MODEL,
  CFO_REPORT_PROVIDER,
  type CfoReportSummary,
} from '@/lib/ai/cfo-report';
import { computeCostMicros } from '@/lib/ai/pricing';
import { cfoReportSchema } from '@/lib/validation/cfo-report';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Action for the Weekly CFO Report AI write-up (Sprint 8, AI margin roadmap; plan §13).
 *
 * The DETERMINISTIC report is loaded server-side on the page (manager-only), so its figures
 * are always visible. This action adds only the PREMIUM AI narrative: it is manager-only,
 * quota-metered per month (feature `kitchen_cfo_report`; Starter = 0), plus a per-minute rate
 * limit. Order (all before any provider call): RBAC → Zod → rate limit → rebuild the report
 * deterministically (NOT_FOUND when there is nothing to report) → monthly usage cap
 * (race-safe). The provider is then called OUTSIDE any DB transaction and its output validated
 * inside the summarizer; the attempt is flipped to `succeeded` with usage/cost and audited. A
 * provider failure records a `failed` attempt and returns a stable code while the deterministic
 * report stays visible.
 *
 * RULE #1: org id from Clerk on the server, reads inside `withOrg` (RLS), Zod on all input.
 * Audit metadata is ids/counts/status/riskLevel only — NEVER amounts, item names, or prose.
 */

const REPORT_FEATURE = 'kitchen_cfo_report' as const;

export type CfoReportSummaryResult = { summary: CfoReportSummary };

export async function summarizeCfoReportAction(
  input: unknown,
): Promise<ActionResult<CfoReportSummaryResult>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = cfoReportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const userId = await getUserId();

  // Burst/abuse control before any org work (the monthly cap is the quota control).
  const limit = await enforceRateLimit(getDb(), 'aiCfoReport', `${organizationId}:${userId}`);
  if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

  const weekTo = parsed.data.weekTo ?? defaultCfoWeekTo();
  const [report, settings] = await Promise.all([
    withOrg(organizationId, (tx) => loadCfoReport(tx, organizationId, weekTo)),
    getOrgSettings(),
  ]);
  // Nothing to narrate (no sales, no leaks, no changes, no low stock) → never reach the provider.
  if (!report.hasData) return { ok: false, code: 'NOT_FOUND' };

  // Monthly usage cap (race-safe): a (org, feature, month) advisory lock serializes the
  // check; the pending attempt is created in the same tx + lock so check and reservation
  // commit together.
  const { limit: monthlyLimit } = await weeklyCfoReportMonthlyLimit();
  const now = new Date();
  const monthStart = monthStartUtc(now);
  const gate = await withOrg(organizationId, async (tx) => {
    await lockMonthlyOperationQuota(tx, organizationId, REPORT_FEATURE, monthStart);
    const used = await countReservedOperations(tx, organizationId, REPORT_FEATURE, monthStart, now);
    if (used >= monthlyLimit) return { capped: true as const };
    const attempt = await createOperationAttempt(tx, organizationId, {
      actorUserId: userId,
      feature: REPORT_FEATURE,
      provider: CFO_REPORT_PROVIDER,
      model: CFO_REPORT_MODEL,
    });
    return { capped: false as const, attemptId: attempt.id };
  });
  if (gate.capped) return { ok: false, code: 'USAGE_LIMIT_REACHED' };
  const attemptId = gate.attemptId;

  const actor = await auditActor();
  const facts = buildCfoReportFacts(report, settings.currency);

  // Provider call OUTSIDE any DB transaction. Output is validated inside the summarizer.
  let result;
  try {
    result = await getCfoReportSummarizer().summarize(facts);
  } catch (err) {
    const busy = err instanceof CfoReportError && err.retryable;
    const code = busy ? 'AI_CFO_REPORT_BUSY' : 'AI_CFO_REPORT_FAILED';
    const eventId = logError({ action: 'summarizeCfoReport', orgId: organizationId }, err);
    await withOrg(organizationId, async (tx) => {
      await markOperationFailed(tx, organizationId, attemptId, { errorCode: code });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.cfoReportFailed',
        entityType: 'aiOperationAttempt',
        entityId: attemptId,
        metadata: {
          provider: CFO_REPORT_PROVIDER,
          reason: busy
            ? 'overloaded'
            : err instanceof CfoReportError
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
        resultType: 'cfoReport',
        resultId: attemptId,
      });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.cfoReport',
        entityType: 'aiOperationAttempt',
        entityId: attemptId,
        // Descriptors + provider metadata only — never amounts, item names or raw prose.
        metadata: {
          provider: result.provider,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          riskLevel: result.summary.riskLevel,
          weekTo,
          attempts: result.attempts ?? 1,
        },
      });
    });
    return { ok: true, data: { summary: result.summary } };
  } catch (err) {
    await withOrg(organizationId, (tx) =>
      markOperationFailed(tx, organizationId, attemptId, { errorCode: 'AI_CFO_REPORT_FAILED' }),
    ).catch(() => undefined);
    return unexpected('summarizeCfoReportAction', err, organizationId);
  }
}
