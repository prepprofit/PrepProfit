'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { MovementError } from '@/lib/data/inventory';
import {
  closePurchaseOrder,
  postReceipt,
  voidReceipt,
} from '@/lib/data/receipts';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  closePurchaseOrderSchema,
  postReceiptSchema,
  voidReceiptSchema,
} from '@/lib/validation/receipts';
import type { ActionResult, ActionErrorCode } from '@/lib/action-result';

/**
 * Server Actions for goods receiving (Sprint 8b). MANAGER-ONLY — every action returns
 * FORBIDDEN before any data access (procurement/inventory data, F4 matrix). RULE #1:
 * org id from Clerk, writes inside `withOrg` (RLS), Zod on all input. Mutations are
 * audited in-tx; metadata is ids/counts/status only — NEVER supplier contact details
 * or per-person money. Not plan-gated (mirrors Sprint 8a).
 */

function revalidate(purchaseOrderId: string): void {
  revalidatePath('/purchase-orders');
  revalidatePath(`/purchase-orders/${purchaseOrderId}`);
  // Stock + pending-cost flags change on the ingredients screen.
  revalidatePath('/ingredients');
}

/** Map an F1 batch `MovementError` thrown out of `withOrg` to a stable code. */
function movementErrorCode(reason: MovementError['reason']): ActionErrorCode {
  switch (reason) {
    case 'insufficient_stock':
      return 'INSUFFICIENT_STOCK';
    case 'idempotency_conflict':
      return 'IDEMPOTENCY_CONFLICT';
    case 'not_found':
      return 'PO_LINE_INGREDIENT_MISSING';
  }
}

export async function postReceiptAction(input: unknown): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = postReceiptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await postReceipt(tx, organizationId, actor.userId, parsed.data);
      if (result.status !== 'ok') return result.status;
      // A deduped retry already audited the original post — don't double-write.
      if (!result.deduped) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'purchaseOrder.receive',
          entityType: 'purchaseOrder',
          entityId: parsed.data.purchaseOrderId,
          metadata: {
            receiptId: result.receipt.id,
            lineCount: parsed.data.items.length,
          },
        });
      }
      return 'ok' as const;
    });

    if (outcome === 'not_receivable') return { ok: false, code: 'PO_NOT_RECEIVABLE' };
    if (outcome === 'line_ingredient_missing') {
      return { ok: false, code: 'PO_LINE_INGREDIENT_MISSING' };
    }
    if (outcome === 'invalid') return { ok: false, code: 'INVALID_INPUT' };
    if (outcome === 'conflict') return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    revalidate(parsed.data.purchaseOrderId);
    return { ok: true, data: undefined };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    throw err;
  }
}

export async function voidReceiptAction(input: unknown): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = voidReceiptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  try {
    const result = await withOrg(organizationId, async (tx) => {
      const outcome = await voidReceipt(tx, organizationId, parsed.data.receiptId);
      if (outcome.status === 'ok' && !outcome.alreadyVoided) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'purchaseOrder.receiptVoid',
          entityType: 'receipt',
          entityId: parsed.data.receiptId,
        });
      }
      return outcome;
    });

    if (result.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    // We don't have the PO id without a read; revalidate the list + ingredients.
    revalidatePath('/purchase-orders');
    revalidatePath('/ingredients');
    return { ok: true, data: undefined };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    throw err;
  }
}

export async function closePurchaseOrderAction(
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = closePurchaseOrderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  if (parsed.data.reason.length === 0) {
    return { ok: false, code: 'PO_CLOSE_REASON_REQUIRED' };
  }

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await closePurchaseOrder(
      tx,
      organizationId,
      parsed.data.purchaseOrderId,
      parsed.data.reason,
    );
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'purchaseOrder.close',
      entityType: 'purchaseOrder',
      entityId: parsed.data.purchaseOrderId,
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'not_partially_received') {
    return { ok: false, code: 'PO_NOT_CLOSABLE' };
  }
  revalidate(parsed.data.purchaseOrderId);
  return { ok: true, data: undefined };
}
