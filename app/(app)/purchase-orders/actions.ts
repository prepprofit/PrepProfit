'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  cancelPurchaseOrder,
  createDraftPurchaseOrder,
  deleteDraftPurchaseOrder,
  sendPurchaseOrder,
  updateDraftPurchaseOrder,
} from '@/lib/data/purchase-orders';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { purchaseOrderDraftSchema } from '@/lib/validation/purchase-orders';
import type { ActionResult } from '@/lib/action-result';
import type { PurchaseOrder } from '@/lib/db/schema';

/**
 * Server Actions for Purchase Orders (Sprint 8a). MANAGER-ONLY — every action
 * returns FORBIDDEN before any data access (procurement/financial data, F4 matrix).
 * RULE #1: org id from Clerk, writes inside `withOrg` (RLS), Zod on all input.
 * Mutations are audited in-tx; metadata is ids/number/status/counts only — NEVER
 * supplier contact details. POs are not plan-gated (all plans, Sprint 8a decision).
 */

function revalidatePurchaseOrders(id?: string): void {
  revalidatePath('/purchase-orders');
  if (id) revalidatePath(`/purchase-orders/${id}`);
}

export async function createPurchaseOrderAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = purchaseOrderDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await createDraftPurchaseOrder(tx, organizationId, parsed.data);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'purchaseOrder.create',
      entityType: 'purchaseOrder',
      entityId: result.order.id,
      metadata: {
        number: result.order.number,
        itemCount: parsed.data.items.length,
      },
    });
    return result.order;
  });

  if (outcome === 'invalid') return { ok: false, code: 'INVALID_INPUT' };
  revalidatePurchaseOrders(outcome.id);
  return { ok: true, data: { id: outcome.id } };
}

export async function updatePurchaseOrderAction(
  id: string,
  input: unknown,
): Promise<ActionResult<PurchaseOrder>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = purchaseOrderDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await updateDraftPurchaseOrder(tx, organizationId, id, parsed.data);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'purchaseOrder.update',
      entityType: 'purchaseOrder',
      entityId: id,
      metadata: {
        number: result.order.number,
        itemCount: parsed.data.items.length,
      },
    });
    return result.order;
  });

  if (outcome === 'not_draft') return { ok: false, code: 'PO_NOT_DRAFT' };
  if (outcome === 'invalid') return { ok: false, code: 'INVALID_INPUT' };
  if (outcome === 'number_taken') return { ok: false, code: 'PO_NUMBER_TAKEN' };
  revalidatePurchaseOrders(id);
  return { ok: true, data: outcome };
}

export async function sendPurchaseOrderAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await sendPurchaseOrder(tx, organizationId, id);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'purchaseOrder.send',
      entityType: 'purchaseOrder',
      entityId: id,
      metadata: {
        number: result.order.number,
        enqueuedEmail: result.enqueuedEmail,
      },
    });
    return 'ok' as const;
  });

  if (outcome === 'not_draft') return { ok: false, code: 'PO_NOT_DRAFT' };
  if (outcome === 'no_supplier') return { ok: false, code: 'SUPPLIER_REQUIRED' };
  if (outcome === 'supplier_inactive') return { ok: false, code: 'SUPPLIER_INACTIVE' };
  if (outcome === 'empty') return { ok: false, code: 'PO_EMPTY' };
  if (outcome === 'line_ingredient_missing') {
    return { ok: false, code: 'PO_LINE_INGREDIENT_MISSING' };
  }
  revalidatePurchaseOrders(id);
  return { ok: true, data: undefined };
}

export async function cancelPurchaseOrderAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await cancelPurchaseOrder(tx, organizationId, id);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'purchaseOrder.cancel',
      entityType: 'purchaseOrder',
      entityId: id,
      metadata: {
        number: result.order.number,
        cancelNoticeEnqueued: result.cancelNoticeEnqueued,
      },
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'has_receipts') return { ok: false, code: 'PO_NOT_CANCELLABLE' };
  revalidatePurchaseOrders(id);
  return { ok: true, data: undefined };
}

export async function deletePurchaseOrderAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const deleted = await withOrg(organizationId, async (tx) => {
    const ok = await deleteDraftPurchaseOrder(tx, organizationId, id);
    if (ok) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'purchaseOrder.delete',
        entityType: 'purchaseOrder',
        entityId: id,
      });
    }
    return ok;
  });

  if (!deleted) return { ok: false, code: 'PO_NOT_DRAFT' };
  revalidatePurchaseOrders();
  return { ok: true, data: undefined };
}
