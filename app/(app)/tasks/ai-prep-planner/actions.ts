'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { logError, unexpected } from '@/lib/observability';
import { prepPlanSummaryMonthlyLimit } from '@/lib/entitlements';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  loadPrepReorderPlan,
  type PrepPlanSelection,
} from '@/lib/data/prep-reorder-plan';
import { createTasksFromPrepPlan } from '@/lib/data/tasks';
import {
  createOperationAttempt,
  markOperationSucceeded,
  markOperationFailed,
  countReservedOperations,
  lockMonthlyOperationQuota,
  monthStartUtc,
} from '@/lib/data/ai-operation-attempts';
import {
  getPrepPlanSummarizer,
  buildPrepPlanSummaryFacts,
  PrepPlanSummaryError,
  PREP_PLAN_SUMMARY_MODEL,
  PREP_PLAN_SUMMARY_PROVIDER,
  type PrepPlanSummary,
} from '@/lib/ai/prep-plan-summary';
import { computeCostMicros } from '@/lib/ai/pricing';
import {
  buildPrepPlanSchema,
  createPrepPlanTasksSchema,
} from '@/lib/validation/prep-planner';
import type { PrepReorderPlan } from '@/lib/calculations/prep-reorder-plan';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for the Prep/Reorder Planner (Sprint 7, AI margin roadmap).
 *
 * The DETERMINISTIC planner is OPERATIONAL and MONEY-FREE, so building a plan is available
 * to BOTH roles on every tier (like the rest of the tasks module). Two things are gated:
 *   - CREATING tasks from the plan is MANAGER-ONLY — the plan can create reorder tasks, and
 *     reorder-task creation is manager-only (Sprint 6 RBAC asymmetry). The user always
 *     reviews the plan before this runs (plan §12 acceptance).
 *   - The optional AI SUMMARY is quota-metered per month (feature prep_reorder_plan_summary;
 *     Starter = 0), plus a per-minute rate limit — the deterministic figures are always
 *     available whether or not the summary is requested.
 *
 * RULE #1: org id from Clerk on the server, reads/writes inside `withOrg` (RLS), Zod on all
 * input. Audit metadata is ids/counts/status/supplyRisk only — NEVER quantities, item names,
 * or the summary prose (CLAUDE.md).
 */

const SUMMARY_FEATURE = 'prep_reorder_plan_summary' as const;

export type PrepPlanResult = { plan: PrepReorderPlan };

/**
 * Build a deterministic prep/reorder plan from a demand selection (both roles, money-free).
 * A pure read — no persistence, no provider call. Returns the plan for review.
 */
export async function buildPrepPlanAction(
  input: unknown,
): Promise<ActionResult<PrepPlanResult>> {
  const parsed = buildPrepPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const selection: PrepPlanSelection = {
    recipes: parsed.data.recipes,
    menus: parsed.data.menus,
  };
  try {
    const plan = await withOrg(organizationId, (tx) =>
      loadPrepReorderPlan(tx, organizationId, selection),
    );
    return { ok: true, data: { plan } };
  } catch (err) {
    return unexpected('buildPrepPlanAction', err, organizationId);
  }
}

export type CreatePrepPlanTasksData = {
  created: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  skippedCap: number;
};

/**
 * Turn a REVIEWED plan into prep + reorder anchored tasks in a target list (manager-only).
 * Duplicate prevention, validity skipping, and the per-list cap are enforced in the data
 * layer; one audit event records the counts.
 */
export async function createPrepPlanTasksAction(
  input: unknown,
): Promise<ActionResult<CreatePrepPlanTasksData>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = createPrepPlanTasksSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const { listId, prepRecipeIds, reorderIngredientIds } = parsed.data;

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await createTasksFromPrepPlan(tx, organizationId, listId, {
      prepRecipeIds,
      reorderIngredientIds,
    });
    if (result.status !== 'ok') return result.status;
    // Only audit when the call actually created ≥1 task (a pure no-op doesn't audit).
    if (result.created.length > 0) {
      const prepCount = result.created.filter((c) => c.sourceKind === 'prep').length;
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'taskList.prepPlanTasks',
        entityType: 'taskList',
        entityId: listId,
        metadata: {
          created: result.created.length,
          prep: prepCount,
          reorder: result.created.length - prepCount,
          skippedDuplicate: result.skippedDuplicate,
          skippedInvalid: result.skippedInvalid,
          skippedCap: result.skippedCap,
        },
      });
    }
    return {
      created: result.created.length,
      skippedDuplicate: result.skippedDuplicate,
      skippedInvalid: result.skippedInvalid,
      skippedCap: result.skippedCap,
    };
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'not_editable') return { ok: false, code: 'TASK_LIST_NOT_EDITABLE' };
  revalidatePath('/tasks');
  revalidatePath(`/tasks/${listId}`);
  return { ok: true, data: outcome };
}

export type PrepPlanSummaryResult = { summary: PrepPlanSummary };

/**
 * Summarize a prep/reorder plan with AI (both roles, money-free). Order (all before any
 * provider call): Zod → rate limit → rebuild the plan deterministically (so the summary
 * matches current data; NOT_FOUND when there is nothing to prep) → monthly usage cap
 * (race-safe). The provider is called OUTSIDE any DB transaction and its output validated
 * inside the summarizer; the attempt is flipped to `succeeded` with usage/cost and audited.
 * A provider failure records a `failed` attempt and returns a stable code while the
 * deterministic plan stays available.
 */
export async function summarizePrepPlanAction(
  input: unknown,
): Promise<ActionResult<PrepPlanSummaryResult>> {
  const parsed = buildPrepPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const userId = await getUserId();

  // Burst/abuse control before any org work (the monthly cap is the quota control).
  const limit = await enforceRateLimit(getDb(), 'aiPrepPlan', `${organizationId}:${userId}`);
  if (!limit.allowed) return { ok: false, code: 'RATE_LIMITED' };

  const selection: PrepPlanSelection = {
    recipes: parsed.data.recipes,
    menus: parsed.data.menus,
  };
  const plan = await withOrg(organizationId, (tx) =>
    loadPrepReorderPlan(tx, organizationId, selection),
  );
  if (!plan.hasPlan) return { ok: false, code: 'NOT_FOUND' };

  // Monthly usage cap (race-safe): a (org, feature, month) advisory lock serializes the
  // check; the pending attempt is created in the same tx + lock so check and reservation
  // commit together.
  const { limit: monthlyLimit } = await prepPlanSummaryMonthlyLimit();
  const now = new Date();
  const monthStart = monthStartUtc(now);
  const gate = await withOrg(organizationId, async (tx) => {
    await lockMonthlyOperationQuota(tx, organizationId, SUMMARY_FEATURE, monthStart);
    const used = await countReservedOperations(tx, organizationId, SUMMARY_FEATURE, monthStart, now);
    if (used >= monthlyLimit) return { capped: true as const };
    const attempt = await createOperationAttempt(tx, organizationId, {
      actorUserId: userId,
      feature: SUMMARY_FEATURE,
      provider: PREP_PLAN_SUMMARY_PROVIDER,
      model: PREP_PLAN_SUMMARY_MODEL,
    });
    return { capped: false as const, attemptId: attempt.id };
  });
  if (gate.capped) return { ok: false, code: 'USAGE_LIMIT_REACHED' };
  const attemptId = gate.attemptId;

  const actor = await auditActor();
  const facts = buildPrepPlanSummaryFacts(plan);

  // Provider call OUTSIDE any DB transaction. Output is validated inside the summarizer.
  let result;
  try {
    result = await getPrepPlanSummarizer().summarize(facts);
  } catch (err) {
    const busy = err instanceof PrepPlanSummaryError && err.retryable;
    const code = busy ? 'AI_PREP_PLAN_BUSY' : 'AI_PREP_PLAN_FAILED';
    const eventId = logError({ action: 'summarizePrepPlan', orgId: organizationId }, err);
    await withOrg(organizationId, async (tx) => {
      await markOperationFailed(tx, organizationId, attemptId, { errorCode: code });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.prepPlanSummaryFailed',
        entityType: 'aiOperationAttempt',
        entityId: attemptId,
        metadata: {
          provider: PREP_PLAN_SUMMARY_PROVIDER,
          reason: busy
            ? 'overloaded'
            : err instanceof PrepPlanSummaryError
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
        resultType: 'prepPlanSummary',
        resultId: attemptId,
      });
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ai.prepPlanSummary',
        entityType: 'aiOperationAttempt',
        entityId: attemptId,
        // Descriptors + provider metadata only — never quantities, item names or prose.
        metadata: {
          provider: result.provider,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          supplyRisk: result.summary.supplyRisk,
          attempts: result.attempts ?? 1,
        },
      });
    });
    return { ok: true, data: { summary: result.summary } };
  } catch (err) {
    await withOrg(organizationId, (tx) =>
      markOperationFailed(tx, organizationId, attemptId, { errorCode: 'AI_PREP_PLAN_FAILED' }),
    ).catch(() => undefined);
    return unexpected('summarizePrepPlanAction', err, organizationId);
  }
}
