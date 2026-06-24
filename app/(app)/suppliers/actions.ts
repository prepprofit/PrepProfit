'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  archiveSupplier,
  createSupplier,
  reactivateSupplier,
  updateSupplier,
} from '@/lib/data/suppliers';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { supplierSchema } from '@/lib/validation/suppliers';
import type { ActionResult } from '@/lib/action-result';
import type { Supplier } from '@/lib/db/schema';

/**
 * Server Actions for the Suppliers module (Sprint 7). MANAGER-ONLY — every action
 * returns FORBIDDEN before any data access (suppliers are financial/procurement
 * data, F4 matrix). RULE #1: org id from Clerk, writes inside `withOrg` (RLS), Zod
 * on all input. Mutations are audited in-tx; metadata is ids + name only — NEVER
 * the contact fields (email/phone/address/tax id).
 */

function revalidateSuppliers(): void {
  revalidatePath('/suppliers');
  // The legacy supplier mirror surfaces on ingredients; a rename propagates there.
  revalidatePath('/ingredients');
}

export async function createSupplierAction(
  input: unknown,
): Promise<ActionResult<Supplier>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = supplierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await createSupplier(tx, organizationId, parsed.data);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'supplier.create',
      entityType: 'supplier',
      // id only (audit F-07): the supplier name is business data, not an audit
      // descriptor — `entityId` already identifies the row.
      entityId: result.supplier.id,
    });
    return result.supplier;
  });

  if (outcome === 'invalid_name') return { ok: false, code: 'INVALID_INPUT' };
  if (outcome === 'duplicate') return { ok: false, code: 'DUPLICATE_NAME' };
  revalidateSuppliers();
  return { ok: true, data: outcome };
}

export async function updateSupplierAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Supplier>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = supplierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await updateSupplier(tx, organizationId, id, parsed.data);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'supplier.update',
      entityType: 'supplier',
      // id only (audit F-07) — the name is business data, not an audit descriptor.
      entityId: id,
    });
    return result.supplier;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'invalid_name') return { ok: false, code: 'INVALID_INPUT' };
  if (outcome === 'duplicate') return { ok: false, code: 'DUPLICATE_NAME' };
  revalidateSuppliers();
  return { ok: true, data: outcome };
}

export async function archiveSupplierAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await archiveSupplier(tx, organizationId, id);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'supplier.archive',
      entityType: 'supplier',
      entityId: id,
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'in_use') return { ok: false, code: 'SUPPLIER_IN_USE' };
  revalidateSuppliers();
  return { ok: true, data: undefined };
}

export async function reactivateSupplierAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const restored = await withOrg(organizationId, async (tx) => {
    const row = await reactivateSupplier(tx, organizationId, id);
    if (row) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'supplier.restore',
        entityType: 'supplier',
        entityId: id,
      });
    }
    return row;
  });

  if (!restored) return { ok: false, code: 'NOT_FOUND' };
  revalidateSuppliers();
  return { ok: true, data: undefined };
}
