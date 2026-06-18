'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isForeignKeyViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  createCustomer,
  softDeleteCustomer,
  updateCustomer,
} from '@/lib/data/customers';
import {
  createDraftInvoice,
  issueInvoice,
  markInvoicePaid,
  softDeleteDraftInvoice,
  updateDraftInvoice,
  voidInvoice,
} from '@/lib/data/invoices';
import {
  customerSchema,
  invoiceDraftSchema,
  issueInvoiceSchema,
} from '@/lib/validation/invoices';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for invoicing (module 6). RULE #1: org id from Clerk on the
 * server, every write inside `withOrg` (RLS active), Zod on the input. Invoices
 * and customers are financial data — every action returns FORBIDDEN for
 * non-managers BEFORE any data access. A customer/invoice from another org never
 * resolves (org-scoped read), and a cross-tenant link is rejected by the
 * composite FK.
 */

function revalidateInvoices(): void {
  revalidatePath('/invoices');
  revalidatePath('/trash');
}

export async function createCustomerAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = customerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      createCustomer(tx, organizationId, parsed.data),
    );
    revalidateInvoices();
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    return unexpected('createCustomerAction', err, organizationId);
  }
}

export async function updateCustomerAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = customerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    updateCustomer(tx, organizationId, id, parsed.data),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateInvoices();
  return { ok: true, data: undefined };
}

export async function deleteCustomerAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    softDeleteCustomer(tx, organizationId, id),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateInvoices();
  return { ok: true, data: undefined };
}

export async function createInvoiceAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = invoiceDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  try {
    const invoice = await withOrg(organizationId, async (tx) => {
      const row = await createDraftInvoice(tx, organizationId, parsed.data);
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'invoice.create',
        entityType: 'invoice',
        entityId: row.id,
      });
      return row;
    });
    revalidateInvoices();
    return { ok: true, data: { id: invoice.id } };
  } catch (err) {
    // Composite FK: a customer link from another org (or a vanished customer).
    if (isForeignKeyViolation(err)) return { ok: false, code: 'NOT_FOUND' };
    return unexpected('createInvoiceAction', err, organizationId);
  }
}

export async function updateInvoiceAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = invoiceDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const invoice = await withOrg(organizationId, (tx) =>
      updateDraftInvoice(tx, organizationId, id, parsed.data),
    );
    // null = the invoice is missing OR no longer a draft (issued+ are immutable).
    if (!invoice) return { ok: false, code: 'INVOICE_LOCKED' };
  } catch (err) {
    if (isForeignKeyViolation(err)) return { ok: false, code: 'NOT_FOUND' };
    return unexpected('updateInvoiceAction', err, organizationId);
  }
  revalidateInvoices();
  return { ok: true, data: undefined };
}

export async function issueInvoiceAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ number: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = issueInvoiceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const result = await issueInvoice(tx, organizationId, id, parsed.data.dueDate);
      if (result.status === 'ok') {
        await writeAuditEvent(tx, organizationId, actor, {
          action: 'invoice.issue',
          entityType: 'invoice',
          entityId: id,
          metadata: {
            number: result.invoice.number,
            totalCents: result.invoice.totalCents,
          },
        });
      }
      return result;
    });
    if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome.status === 'no_customer') {
      return { ok: false, code: 'INVOICE_NO_CUSTOMER' };
    }
    if (outcome.status === 'empty') return { ok: false, code: 'INVALID_INPUT' };
    revalidateInvoices();
    return { ok: true, data: { number: outcome.invoice.number ?? '' } };
  } catch (err) {
    return unexpected('issueInvoiceAction', err, organizationId);
  }
}

export async function markInvoicePaidAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await markInvoicePaid(tx, organizationId, id);
    if (result === 'ok') {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'invoice.pay',
        entityType: 'invoice',
        entityId: id,
      });
    }
    return result;
  });
  if (outcome === 'not_found') return { ok: false, code: 'INVALID_STATUS_TRANSITION' };
  revalidateInvoices();
  return { ok: true, data: undefined };
}

export async function voidInvoiceAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await voidInvoice(tx, organizationId, id);
    if (result === 'ok') {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'invoice.void',
        entityType: 'invoice',
        entityId: id,
      });
    }
    return result;
  });
  if (outcome === 'not_found') return { ok: false, code: 'INVALID_STATUS_TRANSITION' };
  revalidateInvoices();
  return { ok: true, data: undefined };
}

/** Moves a DRAFT invoice to the trash (issued+ invoices are voided, not deleted). */
export async function deleteInvoiceAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const deleted = await softDeleteDraftInvoice(tx, organizationId, id);
    if (deleted) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'invoice.delete',
        entityType: 'invoice',
        entityId: id,
      });
    }
    return deleted;
  });
  // null = missing OR not a draft (only drafts are trashable).
  if (!row) return { ok: false, code: 'INVOICE_LOCKED' };
  revalidateInvoices();
  return { ok: true, data: undefined };
}
