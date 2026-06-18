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

export async function recordMovementAction(
  input: unknown,
): Promise<ActionResult<{ stockQuantity: number }>> {
  const parsed = movementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const result = await withOrg(organizationId, (tx) =>
    recordMovement(tx, organizationId, parsed.data),
  );
  if (!result.ok) {
    return {
      ok: false,
      code: result.reason === 'insufficient_stock' ? 'INSUFFICIENT_STOCK' : 'NOT_FOUND',
    };
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
