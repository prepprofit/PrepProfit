'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { recordMovement, setLowStockThreshold } from '@/lib/data/inventory';
import { movementSchema, thresholdSchema } from '@/lib/validation/inventory';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for the Inventory module. RULE #1: org id from Clerk on the
 * server, writes inside `withOrg` (RLS active), Zod validation on the server.
 */

const MOVEMENT_ERROR_CODES = {
  insufficient_stock: 'INSUFFICIENT_STOCK',
  idempotency_conflict: 'IDEMPOTENCY_CONFLICT',
  not_found: 'NOT_FOUND',
} as const;

export async function recordMovementAction(
  input: unknown,
): Promise<ActionResult<{ stockQuantity: number }>> {
  const parsed = movementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const { mutationId, ...movement } = parsed.data;
  const organizationId = await getOrgId();
  const result = await withOrg(organizationId, (tx) =>
    recordMovement(tx, organizationId, {
      ...movement,
      source: { type: 'manual' },
      // CLIENT-generated, stable across retry/double-click (F1 criterion #2): the
      // server never mints a fresh id, so a resubmit dedups instead of duplicating.
      idempotencyKey: `manual:${mutationId}`,
    }),
  );
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
  const parsed = thresholdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    setLowStockThreshold(
      tx,
      organizationId,
      ingredientId,
      parsed.data.lowStockThreshold,
    ),
  );
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
