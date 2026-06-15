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
  if (!parsed.success) return { ok: false, error: 'Invalid stock movement.' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    recordMovement(tx, organizationId, parsed.data),
  );
  if (!row) return { ok: false, error: 'Ingredient not found.' };
  revalidatePath('/inventory');
  return { ok: true, data: { stockQuantity: Number(row.stockQuantity) } };
}

export async function setLowStockThresholdAction(
  ingredientId: string,
  input: unknown,
): Promise<ActionResult<{ lowStockThreshold: number | null }>> {
  const parsed = thresholdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid threshold.' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    setLowStockThreshold(
      tx,
      organizationId,
      ingredientId,
      parsed.data.lowStockThreshold,
    ),
  );
  if (!row) return { ok: false, error: 'Ingredient not found.' };
  revalidatePath('/inventory');
  return {
    ok: true,
    data: {
      lowStockThreshold:
        row.lowStockThreshold == null ? null : Number(row.lowStockThreshold),
    },
  };
}
