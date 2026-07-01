'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { getOrgSettingsRow } from '@/lib/data/org-settings';
import {
  updateInvoiceLine,
  applyInvoiceImport,
  voidInvoiceImport,
} from '@/lib/data/supplier-invoice-imports';
import { acceptPendingCost } from '@/lib/data/ingredient-pricing';
import { updateInvoiceLineSchema } from '@/lib/validation/supplier-invoices';
import type { ActionResult } from '@/lib/action-result';
import type { Ingredient, SupplierInvoiceImportLine } from '@/lib/db/schema';

/**
 * Server Actions for the Supplier Invoice Reader review (Sprint 2, AI margin roadmap).
 * MANAGER-ONLY — every action returns FORBIDDEN before any data access (invoice
 * costs are financial/procurement data). RULE #1: org id from Clerk, writes inside
 * `withOrg` (RLS), Zod on all input. Apply/void are audited in-tx; metadata is
 * ids/counts only — NEVER raw line text, prices tied to a person, or supplier contact.
 */

function revalidate(id: string): void {
  revalidatePath(`/suppliers/invoices/import/${id}`);
  // Applying raises pending costs surfaced on ingredients.
  revalidatePath('/ingredients');
}

/** Accepting a pending cost changes recipe/menu costs on read, so refresh those too. */
function revalidateAfterAccept(importId: string): void {
  revalidatePath(`/suppliers/invoices/import/${importId}`);
  revalidatePath('/ingredients');
  revalidatePath('/recipes');
}

export async function updateInvoiceLineAction(
  importId: string,
  lineId: string,
  input: unknown,
): Promise<ActionResult<SupplierInvoiceImportLine>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = updateInvoiceLineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const outcome = await withOrg(organizationId, (tx) =>
    updateInvoiceLine(tx, organizationId, importId, lineId, parsed.data),
  );

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'not_editable') {
    return { ok: false, code: 'INVOICE_IMPORT_NOT_EDITABLE' };
  }
  revalidate(importId);
  return { ok: true, data: outcome.line };
}

export async function applyInvoiceImportAction(
  importId: string,
): Promise<ActionResult<{ applied: number; skipped: number }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    const settings = await getOrgSettingsRow(tx, organizationId);
    const orgCurrency = settings?.currency ?? 'EUR';
    const result = await applyInvoiceImport(
      tx,
      organizationId,
      actor.userId ?? 'unknown',
      importId,
      orgCurrency,
    );
    if (result.status === 'ok') {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'invoiceImport.apply',
        entityType: 'supplierInvoiceImport',
        entityId: importId,
        // Counts only — never prices, ingredient names, or supplier contact.
        metadata: { applied: result.applied, skipped: result.skipped },
      });
    }
    return result;
  });

  switch (outcome.status) {
    case 'not_found':
      return { ok: false, code: 'NOT_FOUND' };
    case 'not_editable':
      return { ok: false, code: 'INVOICE_IMPORT_NOT_EDITABLE' };
    case 'currency_mismatch':
      return { ok: false, code: 'INVOICE_CURRENCY_MISMATCH' };
    case 'empty':
      return { ok: false, code: 'INVOICE_IMPORT_EMPTY' };
    case 'ok':
      revalidate(importId);
      return { ok: true, data: { applied: outcome.applied, skipped: outcome.skipped } };
  }
}

export async function voidInvoiceImportAction(
  importId: string,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await voidInvoiceImport(tx, organizationId, importId);
    if (result.status === 'ok') {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'invoiceImport.void',
        entityType: 'supplierInvoiceImport',
        entityId: importId,
      });
    }
    return result;
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'not_editable') {
    return { ok: false, code: 'INVOICE_IMPORT_NOT_EDITABLE' };
  }
  revalidate(importId);
  return { ok: true, data: undefined };
}

/**
 * Accept an ingredient's pending observed cost from the invoice impact card
 * (Sprint 3). Reuses the SAME data-layer promotion + audit event as the ingredients
 * page: pending → approved (`price_cents`), pending cleared, audited in-tx. The
 * `importId` is only used to revalidate the impact card so the accepted ingredient
 * drops out of the projection. MANAGER-ONLY.
 */
export async function acceptImportPendingCostAction(
  importId: string,
  ingredientId: string,
): Promise<ActionResult<Ingredient>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  if (typeof importId !== 'string' || typeof ingredientId !== 'string') {
    return { ok: false, code: 'INVALID_INPUT' };
  }

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await acceptPendingCost(tx, organizationId, ingredientId);
    if (!result.ok) return result.reason;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'ingredient.priceAccept',
      entityType: 'ingredient',
      entityId: ingredientId,
      // Counts/ids only — never the price tied to a person or supplier contact.
      metadata: { newPriceCents: result.ingredient.priceCents },
    });
    return result.ingredient;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  // Nothing pending (e.g. a double-click after it was already accepted).
  if (outcome === 'nothing_pending') return { ok: false, code: 'INVALID_INPUT' };
  revalidateAfterAccept(importId);
  return { ok: true, data: outcome };
}
