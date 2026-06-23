'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { unexpected } from '@/lib/observability';
import { MovementError } from '@/lib/data/inventory';
import { auditActor, writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import {
  commitStockCount,
  createStockCount,
  deleteStockCount,
  transferStock,
  updateStockCount,
} from '@/lib/data/inventory-areas';
import {
  createStockCountSchema,
  stockCountStateSchema,
  transferSchema,
  updateStockCountSchema,
} from '@/lib/validation/inventory-areas';
import type { ActionResult, ActionErrorCode } from '@/lib/action-result';
import type { StockCount } from '@/lib/db/schema';

/**
 * Inventory depth Server Actions — transfers + physical counts (Sprint 12c). These are
 * OPERATIONAL (the chef does them, money-free) → kitchen OR manager, so there is no
 * `isManager()` gate; `getOrgId()` already requires an authenticated org member.
 * Canonical order: auth (org id) → rate limit → Zod → `withOrg`(mutation + audit in one
 * tx) → targeted revalidate. Audit metadata is ids / area ids / counts only — NEVER
 * quantities, NEVER value.
 */

function revalidateInventory(): void {
  revalidatePath('/inventory');
}

type GuardResult =
  | { denied: 'RATE_LIMITED' }
  | { organizationId: string; actor: AuditActor };

/** Rate-limit guard shared by every depth action (both roles allowed). */
async function depthGuard(): Promise<GuardResult> {
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const limit = await enforceRateLimit(
    getDb(),
    'inventory',
    `${organizationId}:${actor.userId}`,
  );
  if (!limit.allowed) return { denied: 'RATE_LIMITED' as const };
  return { organizationId, actor };
}

/** Map an F1 batch `MovementError` thrown out of `withOrg` to a stable code. */
function movementErrorCode(reason: MovementError['reason']): ActionErrorCode {
  switch (reason) {
    case 'insufficient_stock':
      return 'INSUFFICIENT_STOCK';
    case 'idempotency_conflict':
      return 'IDEMPOTENCY_CONFLICT';
    case 'not_found':
      return 'NOT_FOUND';
  }
}

export async function transferStockAction(
  input: unknown,
): Promise<ActionResult<{ balanceFrom: number; balanceTo: number }>> {
  const guard = await depthGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { organizationId, actor } = guard;
  const data = parsed.data;
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await transferStock(tx, organizationId, {
        ingredientId: data.ingredientId,
        areaFromId: data.areaFromId,
        areaToId: data.areaToId,
        qty: data.qty,
        clientTransferId: data.clientTransferId,
      });
      if (result.status !== 'ok') return result.status;
      // Audit only a real (non-deduped) transfer — a replay re-posts nothing.
      if (!result.deduped) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'inventory.transfer',
          entityType: 'inventoryTransfer',
          entityId: data.clientTransferId,
          metadata: {
            ingredientId: data.ingredientId,
            areaFrom: result.areaFrom.id,
            areaTo: result.areaTo.id,
          },
        });
      }
      return { balanceFrom: result.balanceFrom, balanceTo: result.balanceTo };
    });

    if (typeof outcome === 'string') {
      switch (outcome) {
        case 'area_not_found':
        case 'ingredient_not_found':
          return { ok: false, code: 'NOT_FOUND' };
        case 'same_area':
          return { ok: false, code: 'INVALID_INPUT' };
        case 'insufficient_stock':
          return { ok: false, code: 'INSUFFICIENT_STOCK' };
        case 'idempotency_conflict':
          return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      }
    }
    revalidateInventory();
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    return unexpected('transferStockAction', err, organizationId);
  }
}

export async function createStockCountAction(
  input: unknown,
): Promise<ActionResult<StockCount>> {
  const guard = await depthGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = createStockCountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { organizationId, actor } = guard;
  try {
    const outcome = await withOrg(organizationId, (tx) =>
      createStockCount(tx, organizationId, {
        storageAreaId: parsed.data.storageAreaId,
        note: parsed.data.note ?? null,
        createdBy: actor.userId,
      }),
    );
    if (outcome.status === 'area_not_found') return { ok: false, code: 'NOT_FOUND' };
    revalidateInventory();
    return { ok: true, data: outcome.count };
  } catch (err) {
    return unexpected('createStockCountAction', err, organizationId);
  }
}

export async function updateStockCountAction(
  id: string,
  input: unknown,
): Promise<ActionResult<StockCount>> {
  const guard = await depthGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = updateStockCountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { organizationId } = guard;
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
  try {
    const outcome = await withOrg(organizationId, (tx) =>
      updateStockCount(tx, organizationId, id, expectedUpdatedAt, {
        note: parsed.data.note ?? null,
        items: parsed.data.items,
      }),
    );
    switch (outcome.status) {
      case 'not_found':
        return { ok: false, code: 'NOT_FOUND' };
      case 'stale':
        return { ok: false, code: 'STOCK_COUNT_STALE' };
      case 'not_editable':
        return { ok: false, code: 'INVALID_STATUS_TRANSITION' };
    }
    revalidateInventory();
    return { ok: true, data: outcome.count };
  } catch (err) {
    return unexpected('updateStockCountAction', err, organizationId);
  }
}

export async function deleteStockCountAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const guard = await depthGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = stockCountStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { organizationId } = guard;
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
  try {
    const outcome = await withOrg(organizationId, (tx) =>
      deleteStockCount(tx, organizationId, id, expectedUpdatedAt),
    );
    switch (outcome.status) {
      case 'not_found':
        return { ok: false, code: 'NOT_FOUND' };
      case 'stale':
        return { ok: false, code: 'STOCK_COUNT_STALE' };
      case 'not_editable':
        return { ok: false, code: 'INVALID_STATUS_TRANSITION' };
    }
    revalidateInventory();
    return { ok: true, data: undefined };
  } catch (err) {
    return unexpected('deleteStockCountAction', err, organizationId);
  }
}

export async function commitStockCountAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ movementCount: number }>> {
  const guard = await depthGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = stockCountStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { organizationId, actor } = guard;
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await commitStockCount(tx, organizationId, id, expectedUpdatedAt);
      if (result.status !== 'ok') return result.status;
      // A real (non-replay) commit is the only audited path.
      if (!result.alreadyCommitted) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'inventory.countCommit',
          entityType: 'stockCount',
          entityId: id,
          metadata: {
            areaId: result.count.storageAreaId,
            lineCount: result.lineCount,
            movementCount: result.movementCount,
          },
        });
      }
      return { movementCount: result.movementCount };
    });

    if (typeof outcome === 'string') {
      switch (outcome) {
        case 'not_found':
          return { ok: false, code: 'NOT_FOUND' };
        case 'stale':
          return { ok: false, code: 'STOCK_COUNT_STALE' };
        case 'incomplete':
          // A counted ingredient went missing/trashed before the commit lock.
          return { ok: false, code: 'NOT_FOUND' };
      }
    }
    revalidateInventory();
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    return unexpected('commitStockCountAction', err, organizationId);
  }
}
