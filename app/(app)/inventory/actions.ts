'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { recordMovement, setLowStockThreshold } from '@/lib/data/inventory';
import { auditActor, writeAuditEvent, type AuditActor } from '@/lib/data/audit';
import { movementSchema, thresholdSchema } from '@/lib/validation/inventory';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for the Inventory module. RULE #1: org id from Clerk on the
 * server, writes inside `withOrg` (RLS active), Zod validation on the server.
 * Canonical order (matching depth-actions.ts): auth (org id + actor) → rate limit
 * (`inventory` bucket, 429 → RATE_LIMITED) → Zod → `withOrg`(mutation + audit in one
 * tx) → targeted revalidate. These are OPERATIONAL writes (kitchen OR manager), so
 * there is no `isManager()` gate; `getOrgId()` already requires an org member.
 */

const MOVEMENT_ERROR_CODES = {
  insufficient_stock: 'INSUFFICIENT_STOCK',
  idempotency_conflict: 'IDEMPOTENCY_CONFLICT',
  not_found: 'NOT_FOUND',
} as const;

type GuardResult =
  | { denied: 'RATE_LIMITED' }
  | { organizationId: string; actor: AuditActor };

/** Rate-limit guard shared by the manual inventory actions (both roles allowed). */
async function inventoryGuard(): Promise<GuardResult> {
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

export async function recordMovementAction(
  input: unknown,
): Promise<ActionResult<{ stockQuantity: number }>> {
  const guard = await inventoryGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = movementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { mutationId, ...movement } = parsed.data;
  const { organizationId, actor } = guard;
  const result = await withOrg(organizationId, async (tx) => {
    const res = await recordMovement(tx, organizationId, {
      ...movement,
      source: { type: 'manual' },
      // CLIENT-generated, stable across retry/double-click (F1 criterion #2): the
      // server never mints a fresh id, so a resubmit dedups instead of duplicating.
      idempotencyKey: `manual:${mutationId}`,
    });
    // Audit only a real (non-deduped) manual adjustment — a replay re-posts nothing.
    if (res.ok && !res.deduped) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'inventory.movement',
        entityType: 'ingredient',
        entityId: movement.ingredientId,
        // ids + direction descriptor only — NEVER the delta quantity or note text.
        metadata: {
          direction: movement.deltaCanonical > 0 ? 'in' : 'out',
          hasNote: movement.note != null,
        },
      });
    }
    return res;
  });
  if (!result.ok) {
    return { ok: false, code: MOVEMENT_ERROR_CODES[result.reason] };
  }
  revalidatePath('/inventory');
  return {
    ok: true,
    data: { stockQuantity: Number(result.ingredient.stockQuantity) },
  };
}

export async function setLowStockThresholdAction(
  ingredientId: string,
  input: unknown,
): Promise<ActionResult<{ lowStockThreshold: number | null }>> {
  const guard = await inventoryGuard();
  if ('denied' in guard) return { ok: false, code: guard.denied };

  const parsed = thresholdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { organizationId, actor } = guard;
  const row = await withOrg(organizationId, async (tx) => {
    const updated = await setLowStockThreshold(
      tx,
      organizationId,
      ingredientId,
      parsed.data.lowStockThreshold,
    );
    if (updated) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'inventory.thresholdSet',
        entityType: 'ingredient',
        entityId: ingredientId,
        // id + cleared flag only — NEVER the threshold value.
        metadata: { cleared: parsed.data.lowStockThreshold == null },
      });
    }
    return updated;
  });
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidatePath('/inventory');
  return {
    ok: true,
    data: {
      lowStockThreshold:
        row.lowStockThreshold == null ? null : Number(row.lowStockThreshold),
    },
  };
}
