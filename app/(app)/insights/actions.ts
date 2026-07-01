'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError, unexpected } from '@/lib/observability';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { profitLeakExplanationMonthlyLimit } from '@/lib/entitlements';
import { loadProfitLeaks } from '@/lib/data/profit-leaks';
import {
  getProfitInsight,
  upsertExplanation,
  setDismissed,
  insightDescriptor,
} from '@/lib/data/profit-insights';
import {
  createOperationAttempt,
  markOperationSucceeded,
  markOperationFailed,
  countReservedOperations,
  lockMonthlyOperationQuota,
  monthStartUtc,
} from '@/lib/data/ai-operation-attempts';
import {
  getProfitLeakExplainer,
  ProfitLeakExplanationError,
  PROFIT_LEAK_EXPLANATION_MODEL,
  PROFIT_LEAK_EXPLANATION_PROVIDER,
} from '@/lib/ai/profit-leak-explanation';
import { buildExplanationFacts } from '@/lib/calculations/explanation-facts';
import { computeCostMicros } from '@/lib/ai/pricing';
import type { ActionResult } from '@/lib/action-result';
import type { ProfitLeakFinding } from '@/lib/calculations/profit-leaks';
import type { ProfitLeakExplanationData } from '@/lib/ai/operation-types';

/**
 * Profit Insight Inbox actions (Sprint 4, AI margin roadmap). MANAGER-ONLY — every
 * action returns FORBIDDEN before any data access (margin risk is financial data).
 * RULE #1: org id from Clerk, writes inside `withOrg` (RLS).
 *
 * The Sprint-4 safety contract: an AI explanation can only ever exist for a REAL
 * deterministic finding. Every action re-derives the live findings (`loadProfitLeaks`)
 * and matches the request's `fingerprint` before touching the sidecar — an unknown
 * fingerprint is `NOT_FOUND` and never reaches the provider. A failed or quota-blocked
 * explanation leaves the finding fully visible (it is recomputed on read, not stored).
 */

const FEATURE = 'profit_leak_explanation' as const;

export type ProfitLeakExplanationResult = {
  explanation: ProfitLeakExplanationData;
  /** True when served from the cache (no provider call was made). */
  cached: boolean;
};

/** Re-derive the live findings and return the one matching `fingerprint`, or null. */
async function findByFingerprint(
  organizationId: string,
  fingerprint: string,
): Promise<ProfitLeakFinding | null> {
  return withOrg(organizationId, async (tx) => {
    const findings = await loadProfitLeaks(tx, organizationId);
    return findings.find((f) => f.fingerprint === fingerprint) ?? null;
  });
}

/**
 * Explain a profit-leak finding with AI. Order (all before any provider call): RBAC →
 * rate limit → re-derive finding (NOT_FOUND if gone) → cache hit short-circuit → monthly
 * usage cap (race-safe). Then the provider is called OUTSIDE any DB transaction, the
 * validated explanation is cached, the attempt is flipped to `succeeded` with usage/cost
 * and audited. A provider failure records a `failed` attempt and returns a stable code
 * while the finding stays visible.
 */
export async function explainProfitLeakAction(
  fingerprint: string,
): Promise<ActionResult<ProfitLeakExplanationResult>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    return { ok: false, code: 'INVALID_INPUT' };
  }

  const organizationId = await getOrgId();
  const userId = await getUserId();

  // Burst/abuse control before any org work (the monthly cap is the quota control).
  const limit = await enforceRateLimit(
    getDb(),
    'aiExplain',
    `${organizationId}:${userId}`,
  );
  if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

  // An explanation cannot exist without a deterministic finding: re-derive and match.
  const finding = await findByFingerprint(organizationId, fingerprint);
  if (!finding) return { ok: false, code: 'NOT_FOUND' };

  // Cache hit → return without a provider call (no quota spent).
  const existing = await withOrg(organizationId, (tx) =>
    getProfitInsight(tx, organizationId, fingerprint),
  );
  if (existing?.explanation) {
    return { ok: true, data: { explanation: existing.explanation, cached: true } };
  }

  // Monthly usage cap (race-safe): a (org, feature, month) advisory lock serializes the
  // check; the pending attempt is created in the same tx + lock so check and reservation
  // commit together.
  const { limit: monthlyLimit } = await profitLeakExplanationMonthlyLimit();
  const now = new Date();
  const monthStart = monthStartUtc(now);
  const gate = await withOrg(organizationId, async (tx) => {
    await lockMonthlyOperationQuota(tx, organizationId, FEATURE, monthStart);
    const used = await countReservedOperations(tx, organizationId, FEATURE, monthStart, now);
    if (used >= monthlyLimit) return { capped: true as const };
    const attempt = await createOperationAttempt(tx, organizationId, {
      actorUserId: userId,
      feature: FEATURE,
      provider: PROFIT_LEAK_EXPLANATION_PROVIDER,
      model: PROFIT_LEAK_EXPLANATION_MODEL,
    });
    return { capped: false as const, attemptId: attempt.id };
  });
  if (gate.capped) return { ok: false, code: 'USAGE_LIMIT_REACHED' };
  const attemptId = gate.attemptId;

  const actor = await auditActor();
  const facts = buildExplanationFacts(finding);

  // Provider call OUTSIDE any DB transaction. Output is validated inside the explainer.
  let result;
  try {
    result = await getProfitLeakExplainer().explain(facts);
  } catch (err) {
    const busy = err instanceof ProfitLeakExplanationError && err.retryable;
    const code = busy ? 'AI_EXPLAIN_BUSY' : 'AI_EXPLAIN_FAILED';
    const eventId = logError({ action: 'profitLeakExplain', orgId: organizationId }, err);
    await withOrg(organizationId, async (tx) => {
      await markOperationFailed(tx, organizationId, attemptId, { errorCode: code });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.profitLeakExplainFailed',
        entityType: 'aiOperationAttempt',
        entityId: attemptId,
        metadata: {
          provider: PROFIT_LEAK_EXPLANATION_PROVIDER,
          reason: busy
            ? 'overloaded'
            : err instanceof ProfitLeakExplanationError
              ? 'provider'
              : 'unexpected',
          eventId,
        },
      });
    }).catch(() => undefined);
    return { ok: false, code };
  }

  try {
    const insight = await withOrg(organizationId, async (tx) => {
      const row = await upsertExplanation(tx, organizationId, {
        descriptor: insightDescriptor(finding),
        explanation: result.explanation,
        model: result.model,
      });
      await markOperationSucceeded(tx, organizationId, attemptId, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costMicros: computeCostMicros({
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        }),
        qualityFlags: [],
        resultType: 'profit_insight',
        resultId: row.id,
      });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.profitLeakExplain',
        entityType: 'profitInsight',
        entityId: row.id,
        // Descriptors + provider metadata only — never entity names or raw prose.
        metadata: {
          provider: result.provider,
          model: result.model,
          findingType: finding.type,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          riskLevel: result.explanation.riskLevel,
          attempts: result.attempts ?? 1,
        },
      });
      return row;
    });
    revalidatePath('/insights');
    // upsertExplanation always writes a non-null explanation on this path.
    return { ok: true, data: { explanation: insight.explanation!, cached: false } };
  } catch (err) {
    await withOrg(organizationId, (tx) =>
      markOperationFailed(tx, organizationId, attemptId, { errorCode: 'AI_EXPLAIN_FAILED' }),
    ).catch(() => undefined);
    return unexpected('explainProfitLeakAction', err, organizationId);
  }
}

/** Shared dismiss/restore: re-derive the finding, then flip its triage flag. */
async function setDismissedForFinding(
  fingerprint: string,
  dismissed: boolean,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    return { ok: false, code: 'INVALID_INPUT' };
  }

  const organizationId = await getOrgId();
  const finding = await findByFingerprint(organizationId, fingerprint);
  if (!finding) return { ok: false, code: 'NOT_FOUND' };

  const actor = await auditActor();
  try {
    await withOrg(organizationId, async (tx) => {
      const row = await setDismissed(tx, organizationId, insightDescriptor(finding), dismissed);
      await writeAuditEvent(tx, organizationId, actor, {
        action: dismissed ? 'profitInsight.dismiss' : 'profitInsight.restore',
        entityType: 'profitInsight',
        entityId: row.id,
        metadata: { findingType: finding.type },
      });
    });
    revalidatePath('/insights');
    return { ok: true, data: undefined };
  } catch (err) {
    return unexpected('setDismissedForFinding', err, organizationId);
  }
}

/** Hide a handled finding from the active inbox (manager-only). */
export async function dismissInsightAction(fingerprint: string): Promise<ActionResult> {
  return setDismissedForFinding(fingerprint, true);
}

/** Bring a dismissed finding back into the active inbox (manager-only). */
export async function restoreInsightAction(fingerprint: string): Promise<ActionResult> {
  return setDismissedForFinding(fingerprint, false);
}
