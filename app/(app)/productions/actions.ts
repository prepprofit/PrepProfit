'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { MovementError } from '@/lib/data/inventory';
import {
  completeProduction,
  createProduction,
  getProductionById,
  planProduction,
  reopenProduction,
  softDeleteProduction,
  updateDraftProduction,
  voidProduction,
  type ProductionFields,
  type ProductionItemInput,
} from '@/lib/data/productions';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  createProductionSchema,
  productionStateSchema,
  updateProductionSchema,
} from '@/lib/validation/productions';
import type { ActionResult, ActionErrorCode } from '@/lib/action-result';
import type { Production } from '@/lib/db/schema';

/**
 * Server Actions for production planning (Sprint 11a). BOTH roles (kitchen +
 * manager) may create/update/plan/reopen/soft-delete — kitchen payloads carry no
 * money (the loaders strip it). Trash restore/purge are manager-only and live in
 * app/(app)/trash/actions.ts. There is NO feature-plan gate (D7).
 *
 * RULE #1: org id from Clerk on the server, writes inside `withOrg` (RLS), Zod on
 * all input. Canonical order per action: Zod → withOrg(mutation + audit in one tx)
 * → targeted revalidate. A refused/stale/no-op operation does NOT audit. Audit
 * metadata is ids/counts/portions/transition/changed-field names only — NEVER cost
 * or any ingredient financial field (CLAUDE.md).
 */

function revalidateProductions(id?: string): void {
  revalidatePath('/productions');
  if (id) revalidatePath(`/productions/${id}`);
  revalidatePath('/trash');
}

function toFieldsAndItems(parsed: {
  reference?: string | null;
  notes?: string | null;
  plannedFor?: string | null;
  items: ProductionItemInput[];
}): { fields: ProductionFields; items: ProductionItemInput[] } {
  return {
    fields: {
      reference: parsed.reference ?? null,
      notes: parsed.notes ?? null,
      plannedFor: parsed.plannedFor ?? null,
    },
    items: parsed.items.map((i) => ({
      recipeId: i.recipeId,
      plannedQty: i.plannedQty,
    })),
  };
}

const totalPortions = (items: ProductionItemInput[]): number =>
  items.reduce((sum, i) => sum + i.plannedQty, 0);

export async function createProductionAction(
  input: unknown,
): Promise<ActionResult<Production>> {
  const parsed = createProductionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const { fields, items } = toFieldsAndItems(parsed.data);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await createProduction(tx, organizationId, fields, items);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'production.create',
      entityType: 'production',
      entityId: result.production.id,
      metadata: {
        itemCount: items.length,
        totalPlannedPortions: totalPortions(items),
        hasPlannedDate: fields.plannedFor !== null,
      },
    });
    return result.production;
  });

  if (outcome === 'recipe_invalid') {
    return { ok: false, code: 'PRODUCTION_RECIPE_INVALID' };
  }
  revalidateProductions(outcome.id);
  return { ok: true, data: outcome };
}

export async function updateProductionAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Production>> {
  const parsed = updateProductionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const { fields, items } = toFieldsAndItems(parsed.data);
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    // Snapshot the prior fields (for the non-sensitive change descriptor) before the
    // in-tx replace. A missing/trashed production → not_found from the mutation.
    const before = await getProductionById(tx, organizationId, id);

    const result = await updateDraftProduction(
      tx,
      organizationId,
      id,
      expectedUpdatedAt,
      fields,
      items,
    );
    if (result.status !== 'ok') return result.status;

    const changedFields: string[] = [];
    if ((before?.reference ?? null) !== fields.reference) changedFields.push('reference');
    if ((before?.notes ?? null) !== fields.notes) changedFields.push('notes');
    if ((before?.plannedFor ?? null) !== fields.plannedFor) {
      changedFields.push('plannedFor');
    }

    await writeAuditEvent(tx, organizationId, actor, {
      action: 'production.update',
      entityType: 'production',
      entityId: id,
      metadata: {
        itemCount: items.length,
        totalPlannedPortions: totalPortions(items),
        changedFields,
      },
    });
    return result.production;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'PRODUCTION_STALE' };
  if (outcome === 'not_editable') return { ok: false, code: 'PRODUCTION_NOT_EDITABLE' };
  if (outcome === 'recipe_invalid') {
    return { ok: false, code: 'PRODUCTION_RECIPE_INVALID' };
  }
  revalidateProductions(id);
  return { ok: true, data: outcome };
}

export async function planProductionAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Production>> {
  const parsed = productionStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await planProduction(tx, organizationId, id, expectedUpdatedAt);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'production.plan',
      entityType: 'production',
      entityId: id,
      metadata: { from: 'draft', to: 'planned' },
    });
    return result.production;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'PRODUCTION_STALE' };
  if (outcome === 'not_editable') return { ok: false, code: 'PRODUCTION_NOT_EDITABLE' };
  if (outcome === 'incomplete') return { ok: false, code: 'PRODUCTION_INCOMPLETE' };
  revalidateProductions(id);
  return { ok: true, data: outcome };
}

export async function reopenProductionAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Production>> {
  const parsed = productionStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await reopenProduction(tx, organizationId, id, expectedUpdatedAt);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'production.reopen',
      entityType: 'production',
      entityId: id,
      metadata: { from: 'planned', to: 'draft' },
    });
    return result.production;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'PRODUCTION_STALE' };
  if (outcome === 'not_editable') return { ok: false, code: 'PRODUCTION_NOT_EDITABLE' };
  revalidateProductions(id);
  return { ok: true, data: outcome };
}

export async function deleteProductionAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = productionStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await softDeleteProduction(
      tx,
      organizationId,
      id,
      expectedUpdatedAt,
    );
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'production.delete',
      entityType: 'production',
      entityId: id,
    });
    return 'done' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'PRODUCTION_STALE' };
  if (outcome === 'not_deletable') {
    return { ok: false, code: 'PRODUCTION_NOT_DELETABLE' };
  }
  revalidateProductions(id);
  return { ok: true, data: undefined };
}

/** Map an F1 batch `MovementError` thrown out of `withOrg` to a stable code. */
function movementErrorCode(reason: MovementError['reason']): ActionErrorCode {
  switch (reason) {
    case 'insufficient_stock':
      return 'INSUFFICIENT_STOCK';
    case 'idempotency_conflict':
      return 'IDEMPOTENCY_CONFLICT';
    case 'not_found':
      // The posting inputs disappeared/trashed before the ledger lock; the row stays
      // planned after rollback.
      return 'PRODUCTION_INCOMPLETE';
  }
}

/**
 * `planned → completed` (Sprint 11b). BOTH roles may complete (D1) — the cost snapshot
 * is frozen server-side and withheld from the kitchen DTO. Posts F1 OUT movements +
 * freezes the cost/consumption snapshot in one transaction. The `MovementError` (hard
 * stock floor / conflict) is caught OUTSIDE `withOrg`, after rollback. A
 * refused/stale/incomplete/insufficient op — and an already-completed no-op — does NOT
 * audit.
 */
export async function completeProductionAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Production>> {
  const parsed = productionStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await completeProduction(
        tx,
        organizationId,
        id,
        expectedUpdatedAt,
      );
      if (result.status !== 'ok') return result.status;
      // An idempotent retry against an already-completed run writes no second audit.
      if (!result.alreadyCompleted) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'production.complete',
          entityType: 'production',
          entityId: id,
          metadata: {
            itemCount: result.itemCount,
            totalPlannedPortions: result.totalPlannedPortions,
            ingredientCount: result.ingredientCount,
            stockMoved: result.stockMoved,
            movementCount: result.movementCount,
          },
        });
      }
      return result.production;
    });

    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'stale') return { ok: false, code: 'PRODUCTION_STALE' };
    if (outcome === 'not_completable') {
      return { ok: false, code: 'PRODUCTION_NOT_COMPLETABLE' };
    }
    if (outcome === 'incomplete') {
      return { ok: false, code: 'PRODUCTION_INCOMPLETE' };
    }
    revalidateProductions(id);
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    throw err;
  }
}

/**
 * `completed → voided` (Sprint 11b). MANAGER-ONLY (D2) — corrections/financial
 * reversals are manager territory. Posts F1 reversals for the booked OUT movements and
 * retains the row as history. An already-voided no-op does NOT audit.
 */
export async function voidProductionAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Production>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = productionStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await voidProduction(tx, organizationId, id, expectedUpdatedAt);
      if (result.status !== 'ok') return result.status;
      if (!result.alreadyVoided) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'production.void',
          entityType: 'production',
          entityId: id,
          metadata: { reversalCount: result.reversalCount },
        });
      }
      return result.production;
    });

    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'stale') return { ok: false, code: 'PRODUCTION_STALE' };
    if (outcome === 'not_voidable') {
      return { ok: false, code: 'PRODUCTION_NOT_VOIDABLE' };
    }
    revalidateProductions(id);
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    throw err;
  }
}
