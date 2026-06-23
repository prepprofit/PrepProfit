'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isUniqueViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import { requireFeature } from '@/lib/entitlements';
import { MovementError } from '@/lib/data/inventory';
import {
  createSale,
  deleteSale,
  postSale,
  updateSale,
  voidSale,
  type SaleLineInput,
} from '@/lib/data/sales';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  createSaleSchema,
  saleStateSchema,
  updateSaleSchema,
} from '@/lib/validation/sales';
import type { ActionResult, ActionErrorCode } from '@/lib/action-result';
import type { Sale } from '@/lib/db/schema';

/**
 * Server Actions for daily-close Sales (Sprint 12a). Sales are FINANCIAL →
 * MANAGER-ONLY, and gated by the `invoices` plan feature (D4 — Pro+). Canonical order
 * per action: RBAC (`isManager()`) → entitlement (`requireFeature('invoices')`) → Zod
 * → `withOrg`(mutation + audit in one tx) → targeted revalidate. Kitchen gets
 * `FORBIDDEN` before any data access; a manager on a plan without the feature gets
 * `UPGRADE_REQUIRED` before data.
 *
 * Audit metadata is ids / counts / status / stockMoved / movement+reversal counts /
 * transaction id only — NEVER the gross/net/tax amounts or any item name (CLAUDE.md).
 */

function revalidateSales(id?: string): void {
  revalidatePath('/sales');
  if (id) revalidatePath(`/sales/${id}`);
  // Posting/voiding writes/soft-deletes the income transaction → refresh financials.
  revalidatePath('/transactions');
  revalidatePath('/financials');
  revalidatePath('/dashboard');
}

/** RBAC → entitlement gate shared by every sales action. Null = allowed. */
async function guard(): Promise<ActionErrorCode | null> {
  if (!(await isManager())) return 'FORBIDDEN';
  return requireFeature('invoices');
}

/** Map an F1 batch `MovementError` thrown out of `withOrg` to a stable code. */
function movementErrorCode(reason: MovementError['reason']): ActionErrorCode {
  switch (reason) {
    case 'insufficient_stock':
      return 'INSUFFICIENT_STOCK';
    case 'idempotency_conflict':
      return 'IDEMPOTENCY_CONFLICT';
    case 'not_found':
      // A consumed ingredient disappeared/trashed before the ledger lock.
      return 'SALE_INCOMPLETE';
  }
}

export async function createSaleAction(
  input: unknown,
): Promise<ActionResult<Sale>> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = createSaleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const lines = parsed.data.lines as SaleLineInput[];

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await createSale(
        tx,
        organizationId,
        { saleDate: parsed.data.saleDate, note: parsed.data.note ?? null },
        lines,
      );
      if (result.status !== 'ok') return result.status;
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'sale.create',
        entityType: 'sale',
        entityId: result.sale.id,
        metadata: { lineCount: lines.length },
      });
      return result.sale;
    });

    if (outcome === 'date_taken') return { ok: false, code: 'SALE_DATE_TAKEN' };
    if (outcome === 'invalid_source') return { ok: false, code: 'SALE_INCOMPLETE' };
    revalidateSales(outcome.id);
    return { ok: true, data: outcome };
  } catch (err) {
    // Race backstop: two concurrent creates for the same date — the partial unique
    // index rejects the loser.
    if (isUniqueViolation(err)) return { ok: false, code: 'SALE_DATE_TAKEN' };
    return unexpected('createSaleAction', err, organizationId);
  }
}

export async function updateSaleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Sale>> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = updateSaleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const lines = parsed.data.lines as SaleLineInput[];
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await updateSale(
        tx,
        organizationId,
        id,
        expectedUpdatedAt,
        { saleDate: parsed.data.saleDate, note: parsed.data.note ?? null },
        lines,
      );
      if (result.status !== 'ok') return result.status;
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'sale.update',
        entityType: 'sale',
        entityId: id,
        metadata: { lineCount: lines.length },
      });
      return result.sale;
    });

    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'stale') return { ok: false, code: 'SALE_STALE' };
    if (outcome === 'not_editable') return { ok: false, code: 'SALE_NOT_EDITABLE' };
    if (outcome === 'invalid_source') return { ok: false, code: 'SALE_INCOMPLETE' };
    if (outcome === 'date_taken') return { ok: false, code: 'SALE_DATE_TAKEN' };
    revalidateSales(id);
    return { ok: true, data: outcome };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 'SALE_DATE_TAKEN' };
    return unexpected('updateSaleAction', err, organizationId);
  }
}

export async function deleteSaleAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = saleStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await deleteSale(tx, organizationId, id, expectedUpdatedAt);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'sale.delete',
      entityType: 'sale',
      entityId: id,
    });
    return 'done' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'SALE_STALE' };
  if (outcome === 'not_editable') return { ok: false, code: 'SALE_NOT_EDITABLE' };
  revalidateSales(id);
  return { ok: true, data: undefined };
}

/**
 * `draft → posted`. Writes the single protected income row (F5) + idempotent stock
 * consumption (F1). The `MovementError` (hard stock floor / conflict) is caught
 * OUTSIDE `withOrg`, after rollback. A refused/stale/incomplete op — and an
 * already-posted no-op — does NOT audit.
 */
export async function postSaleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Sale>> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = saleStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await postSale(tx, organizationId, id, expectedUpdatedAt);
      if (result.status !== 'ok') return result.status;
      if (!result.alreadyPosted) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'sale.post',
          entityType: 'sale',
          entityId: id,
          metadata: {
            lineCount: result.lineCount,
            ingredientCount: result.ingredientCount,
            stockMoved: result.stockMoved,
            movementCount: result.movementCount,
            transactionId: result.transactionId,
          },
        });
      }
      return result.sale;
    });

    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'stale') return { ok: false, code: 'SALE_STALE' };
    if (outcome === 'not_postable') {
      return { ok: false, code: 'INVALID_STATUS_TRANSITION' };
    }
    if (outcome === 'incomplete') return { ok: false, code: 'SALE_INCOMPLETE' };
    if (outcome === 'tax_rate_required') {
      return { ok: false, code: 'SALES_TAX_RATE_REQUIRED' };
    }
    if (outcome === 'idempotency_conflict') {
      return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    }
    revalidateSales(id);
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    return unexpected('postSaleAction', err, organizationId);
  }
}

/**
 * `posted → void`. Soft-deletes the income row (F5) + reverses the booked OUT
 * movements (F1) and retains the row as history. An already-void no-op does NOT audit.
 */
export async function voidSaleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Sale>> {
  const denied = await guard();
  if (denied) return { ok: false, code: denied };

  const parsed = saleStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await voidSale(tx, organizationId, id, expectedUpdatedAt);
      if (result.status !== 'ok') return result.status;
      if (!result.alreadyVoided) {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'sale.void',
          entityType: 'sale',
          entityId: id,
          metadata: { reversalCount: result.reversalCount },
        });
      }
      return result.sale;
    });

    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'stale') return { ok: false, code: 'SALE_STALE' };
    if (outcome === 'not_voidable') {
      return { ok: false, code: 'INVALID_STATUS_TRANSITION' };
    }
    revalidateSales(id);
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof MovementError) {
      return { ok: false, code: movementErrorCode(err.reason) };
    }
    return unexpected('voidSaleAction', err, organizationId);
  }
}
