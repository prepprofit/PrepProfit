'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isForeignKeyViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import { purgeIngredient, restoreIngredient } from '@/lib/data/ingredients';
import {
  countTrashedIngredientsInRecipe,
  lockRecipeReferencedIngredients,
  purgeRecipe,
  restoreRecipe,
} from '@/lib/data/recipes';
import { purgeTransaction, restoreTransaction } from '@/lib/data/transactions';
import { purgeCustomer, restoreCustomer } from '@/lib/data/customers';
import { purgeInvoice, restoreInvoice } from '@/lib/data/invoices';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for the trash. RULE #1: org id from Clerk on the server, every
 * write inside `withOrg` (RLS active). Restore/purge are per-org operations, so
 * they need no RLS carve-out (unlike the cross-org auto-purge cron).
 *
 * The trash is MANAGER-ONLY: it exposes financial records (transactions,
 * customers, invoices) and destructive purges with financial side-effects. Every
 * action below re-checks `isManager()` before any data access — the hidden nav
 * link and the page guard are just UX reinforcement.
 */

function revalidateTrash(): void {
  revalidatePath('/trash');
  revalidatePath('/recipes');
  revalidatePath('/ingredients');
  revalidatePath('/dashboard');
}

function revalidateTrashFinance(): void {
  revalidateTrash();
  revalidatePath('/transactions');
  revalidatePath('/financials');
}

function revalidateTrashInvoices(): void {
  revalidateTrash();
  revalidatePath('/invoices');
}

export async function restoreRecipeAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  // Block + restore in one transaction so the guard can't be raced. Locking the
  // referenced ingredient rows first serializes against a concurrent ingredient
  // trash (which takes the same locks), so we can't restore the recipe to active
  // just as one of its ingredients is being trashed.
  const outcome = await withOrg(organizationId, async (tx) => {
    await lockRecipeReferencedIngredients(tx, organizationId, id);
    const trashedIngredients = await countTrashedIngredientsInRecipe(
      tx,
      organizationId,
      id,
    );
    if (trashedIngredients > 0) return { status: 'blocked' as const };
    const row = await restoreRecipe(tx, organizationId, id);
    return { status: row ? ('done' as const) : ('not_found' as const) };
  });

  if (outcome.status === 'blocked') {
    return { ok: false, code: 'RECIPE_HAS_TRASHED_INGREDIENTS' };
  }
  if (outcome.status === 'not_found') {
    return { ok: false, code: 'NOT_FOUND' };
  }
  revalidateTrash();
  return { ok: true, data: undefined };
}

export async function restoreIngredientAction(
  id: string,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    restoreIngredient(tx, organizationId, id),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrash();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed recipe (also nulls referencing transactions). */
export async function purgeRecipeAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  await withOrg(organizationId, (tx) => purgeRecipe(tx, organizationId, id));
  // It can unlink transactions, so refresh the financial views too.
  revalidateTrashFinance();
  return { ok: true, data: undefined };
}

export async function purgeIngredientAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  try {
    await withOrg(organizationId, (tx) =>
      purgeIngredient(tx, organizationId, id),
    );
  } catch (err) {
    // restrict FK: still referenced by a trashed recipe's line.
    if (isForeignKeyViolation(err)) {
      return { ok: false, code: 'INGREDIENT_IN_TRASHED_RECIPE' };
    }
    return unexpected('purgeIngredientAction', err, organizationId);
  }
  revalidateTrash();
  return { ok: true, data: undefined };
}

/** Restore a trashed transaction — manager-only (financial data). */
export async function restoreTransactionAction(
  id: string,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    restoreTransaction(tx, organizationId, id),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrashFinance();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed transaction — manager-only. */
export async function purgeTransactionAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  await withOrg(organizationId, (tx) => purgeTransaction(tx, organizationId, id));
  revalidateTrashFinance();
  return { ok: true, data: undefined };
}

/** Restore a trashed customer — manager-only (billing data). */
export async function restoreCustomerAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    restoreCustomer(tx, organizationId, id),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrashInvoices();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed customer — manager-only (nulls invoice links). */
export async function purgeCustomerAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  await withOrg(organizationId, (tx) => purgeCustomer(tx, organizationId, id));
  revalidateTrashInvoices();
  return { ok: true, data: undefined };
}

/** Restore a trashed (draft) invoice — manager-only. */
export async function restoreInvoiceAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const row = await withOrg(organizationId, (tx) =>
    restoreInvoice(tx, organizationId, id),
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrashInvoices();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed (draft) invoice — manager-only. */
export async function purgeInvoiceAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  await withOrg(organizationId, (tx) => purgeInvoice(tx, organizationId, id));
  revalidateTrashInvoices();
  return { ok: true, data: undefined };
}
