'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isForeignKeyViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  createTransaction,
  softDeleteTransaction,
  updateTransaction,
} from '@/lib/data/transactions';
import {
  createCustomCategory,
  deleteCustomCategory,
  getCategoryById,
  renameCustomCategory,
} from '@/lib/data/transaction-categories';
import {
  transactionSchema,
  customCategoryCreateSchema,
  customCategoryRenameSchema,
} from '@/lib/validation/transactions';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for financials. RULE #1: org id from Clerk on the server, every
 * write inside `withOrg` (RLS active), Zod on the input. Financials are
 * manager-only (DoD): every action returns FORBIDDEN for non-managers BEFORE any
 * data access. A category from another org never resolves (org-scoped read), and
 * a cross-tenant recipe link is rejected by the composite FK.
 */

function revalidateFinance(): void {
  revalidatePath('/transactions');
  revalidatePath('/financials');
  revalidatePath('/dashboard');
}

export async function createTransactionAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = transactionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  try {
    const id = await withOrg(organizationId, async (tx) => {
      // The category must exist in this org AND match the transaction's side.
      const category = await getCategoryById(tx, organizationId, parsed.data.categoryId);
      if (!category || category.kind !== parsed.data.type) return null;
      const row = await createTransaction(tx, organizationId, parsed.data);
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'transaction.create',
        entityType: 'transaction',
        entityId: row.id,
        metadata: { type: parsed.data.type, amountCents: parsed.data.amountCents },
      });
      return row.id;
    });
    if (!id) return { ok: false, code: 'INVALID_INPUT' };
    revalidateFinance();
    return { ok: true, data: { id } };
  } catch (err) {
    // Composite FK: a recipe link from another org (or a vanished recipe).
    if (isForeignKeyViolation(err)) return { ok: false, code: 'NOT_FOUND' };
    return unexpected('createTransactionAction', err, organizationId);
  }
}

export async function updateTransactionAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = transactionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  try {
    const outcome = await withOrg(organizationId, async (tx) => {
      const category = await getCategoryById(tx, organizationId, parsed.data.categoryId);
      if (!category || category.kind !== parsed.data.type) {
        return 'invalid' as const;
      }
      const row = await updateTransaction(tx, organizationId, id, parsed.data);
      if (!row) return 'not_found' as const;
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'transaction.update',
        entityType: 'transaction',
        entityId: id,
        metadata: { type: parsed.data.type, amountCents: parsed.data.amountCents },
      });
      return 'ok' as const;
    });
    if (outcome === 'invalid') return { ok: false, code: 'INVALID_INPUT' };
    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    revalidateFinance();
    return { ok: true, data: undefined };
  } catch (err) {
    if (isForeignKeyViolation(err)) return { ok: false, code: 'NOT_FOUND' };
    return unexpected('updateTransactionAction', err, organizationId);
  }
}

/** Moves a transaction to the trash (restore/purge live in the trash actions). */
export async function deleteTransactionAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const deleted = await softDeleteTransaction(tx, organizationId, id);
    if (deleted) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'transaction.delete',
        entityType: 'transaction',
        entityId: id,
      });
    }
    return deleted;
  });
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateFinance();
  return { ok: true, data: undefined };
}

export async function createCategoryAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = customCategoryCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  try {
    const row = await withOrg(organizationId, (tx) =>
      createCustomCategory(tx, organizationId, parsed.data.name, parsed.data.kind),
    );
    revalidateFinance();
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    return unexpected('createCategoryAction', err, organizationId);
  }
}

export async function renameCategoryAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = customCategoryRenameSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    renameCustomCategory(tx, organizationId, id, parsed.data.name),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateFinance();
  return { ok: true, data: undefined };
}

export async function deleteCategoryAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  try {
    const deleted = await withOrg(organizationId, (tx) =>
      deleteCustomCategory(tx, organizationId, id),
    );
    if (!deleted) return { ok: false, code: 'NOT_FOUND' };
  } catch (err) {
    // RESTRICT FK: the category is still referenced by a transaction.
    if (isForeignKeyViolation(err)) return { ok: false, code: 'CATEGORY_IN_USE' };
    return unexpected('deleteCategoryAction', err, organizationId);
  }
  revalidateFinance();
  return { ok: true, data: undefined };
}
