'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { isForeignKeyViolation } from '@/lib/db/errors';
import { unexpected } from '@/lib/observability';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { purgeIngredient, restoreIngredient } from '@/lib/data/ingredients';
import {
  countTrashedIngredientsInRecipe,
  lockRecipeReferencedIngredients,
  restoreRecipe,
} from '@/lib/data/recipes';
import { purgeMenu, restoreMenu } from '@/lib/data/menus';
import { purgeRecipeWithGuards } from '@/lib/data/recipe-purge';
import {
  countProductionMovementsForIngredient,
  purgeProduction,
  restoreProduction,
} from '@/lib/data/productions';
import { purgeTaskList, restoreTaskList } from '@/lib/data/tasks';
import {
  getTransactionAnyState,
  purgeTransaction,
  restoreTransaction,
} from '@/lib/data/transactions';
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
  revalidatePath('/menus');
  revalidatePath('/productions');
  revalidatePath('/tasks');
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
  const actor = await auditActor();
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
    if (!row) return { status: 'not_found' as const };
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'trash.restore',
      entityType: 'recipe',
      entityId: id,
    });
    return { status: 'done' as const };
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
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const restored = await restoreIngredient(tx, organizationId, id);
    if (restored) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'trash.restore',
        entityType: 'ingredient',
        entityId: id,
      });
    }
    return restored;
  });
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrash();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed recipe (also nulls referencing transactions). */
export async function purgeRecipeAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  // A recipe still referenced by a menu (Sprint 10) is purge-blocked BEFORE any
  // side effect: the guard checks the menu reference first, so a blocked purge
  // never nulls a referencing transaction. Remove the menu line (or purge the
  // menu) first.
  const outcome = await withOrg(organizationId, async (tx) => {
    const status = await purgeRecipeWithGuards(tx, organizationId, id);
    if (status !== 'ok') return status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'trash.purge',
      entityType: 'recipe',
      entityId: id,
    });
    return 'ok' as const;
  });
  if (outcome === 'in_menu') return { ok: false, code: 'RECIPE_IN_MENU' };
  if (outcome === 'in_production') return { ok: false, code: 'RECIPE_IN_PRODUCTION' };
  // It can unlink transactions, so refresh the financial views too.
  revalidateTrashFinance();
  return { ok: true, data: undefined };
}

/** Restore a trashed menu — manager-only (Sprint 10). */
export async function restoreMenuAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const restored = await restoreMenu(tx, organizationId, id);
    if (restored) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'trash.restore',
        entityType: 'menu',
        entityId: id,
      });
    }
    return restored;
  });
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrash();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed menu — manager-only (Sprint 10). Items cascade. */
export async function purgeMenuAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  await withOrg(organizationId, async (tx) => {
    await purgeMenu(tx, organizationId, id);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'trash.purge',
      entityType: 'menu',
      entityId: id,
    });
  });
  revalidateTrash();
  return { ok: true, data: undefined };
}

/** Restore a trashed production — manager-only (Sprint 11a). Keeps its prior status. */
export async function restoreProductionAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const restored = await restoreProduction(tx, organizationId, id);
    if (restored) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'trash.restore',
        entityType: 'production',
        entityId: id,
      });
    }
    return restored;
  });
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrash();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed production — manager-only (Sprint 11a). Items cascade. */
export async function purgeProductionAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  await withOrg(organizationId, async (tx) => {
    await purgeProduction(tx, organizationId, id);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'trash.purge',
      entityType: 'production',
      entityId: id,
    });
  });
  revalidateTrash();
  return { ok: true, data: undefined };
}

/** Restore a trashed task list — manager-only (Sprint 6). Keeps its tasks. */
export async function restoreTaskListAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const restored = await restoreTaskList(tx, organizationId, id);
    if (restored) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'trash.restore',
        entityType: 'taskList',
        entityId: id,
      });
    }
    return restored;
  });
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrash();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed task list — manager-only (Sprint 6). Tasks cascade. */
export async function purgeTaskListAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  await withOrg(organizationId, async (tx) => {
    await purgeTaskList(tx, organizationId, id);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'trash.purge',
      entityType: 'taskList',
      entityId: id,
    });
  });
  revalidateTrash();
  return { ok: true, data: undefined };
}

export async function purgeIngredientAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  let outcome: 'ok' | 'in_use';
  try {
    outcome = await withOrg(organizationId, async (tx) => {
      // An ingredient consumed by a completed (stock-moving) production has permanent
      // ledger history and is purge-blocked (Sprint 11b D6) BEFORE any delete — the
      // production_consumptions → movement restrict FK would otherwise raise an
      // ambiguous violation. Surfaced as INGREDIENT_IN_USE.
      const productionMovements = await countProductionMovementsForIngredient(
        tx,
        organizationId,
        id,
      );
      if (productionMovements > 0) return 'in_use' as const;
      await purgeIngredient(tx, organizationId, id);
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'trash.purge',
        entityType: 'ingredient',
        entityId: id,
      });
      return 'ok' as const;
    });
  } catch (err) {
    // restrict FK: still referenced by a trashed recipe's line.
    if (isForeignKeyViolation(err)) {
      return { ok: false, code: 'INGREDIENT_IN_TRASHED_RECIPE' };
    }
    return unexpected('purgeIngredientAction', err, organizationId);
  }
  if (outcome === 'in_use') return { ok: false, code: 'INGREDIENT_IN_USE' };
  revalidateTrash();
  return { ok: true, data: undefined };
}

/** Restore a trashed transaction — manager-only (financial data). */
export async function restoreTransactionAction(
  id: string,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    // Sale-sourced rows are never user-trash (Sprint F5): refuse atomically with
    // no audit on refusal, distinct from NOT_FOUND.
    const existing = await getTransactionAnyState(tx, organizationId, id);
    if (!existing) return 'not_found' as const;
    if (existing.sourceType === 'sale') return 'protected' as const;
    const restored = await restoreTransaction(tx, organizationId, id);
    if (!restored) return 'not_found' as const;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'trash.restore',
      entityType: 'transaction',
      entityId: id,
    });
    return 'ok' as const;
  });
  if (outcome === 'protected') return { ok: false, code: 'PROTECTED_TRANSACTION' };
  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  revalidateTrashFinance();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed transaction — manager-only. */
export async function purgeTransactionAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const existing = await getTransactionAnyState(tx, organizationId, id);
    if (!existing) return 'not_found' as const;
    if (existing.sourceType === 'sale') return 'protected' as const;
    await purgeTransaction(tx, organizationId, id);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'trash.purge',
      entityType: 'transaction',
      entityId: id,
    });
    return 'ok' as const;
  });
  if (outcome === 'protected') return { ok: false, code: 'PROTECTED_TRANSACTION' };
  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  revalidateTrashFinance();
  return { ok: true, data: undefined };
}

/** Restore a trashed customer — manager-only (billing data). */
export async function restoreCustomerAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const restored = await restoreCustomer(tx, organizationId, id);
    if (restored) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'trash.restore',
        entityType: 'customer',
        entityId: id,
      });
    }
    return restored;
  });
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrashInvoices();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed customer — manager-only (nulls invoice links). */
export async function purgeCustomerAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  await withOrg(organizationId, async (tx) => {
    await purgeCustomer(tx, organizationId, id);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'trash.purge',
      entityType: 'customer',
      entityId: id,
    });
  });
  revalidateTrashInvoices();
  return { ok: true, data: undefined };
}

/** Restore a trashed (draft) invoice — manager-only. */
export async function restoreInvoiceAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const restored = await restoreInvoice(tx, organizationId, id);
    if (restored) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'trash.restore',
        entityType: 'invoice',
        entityId: id,
      });
    }
    return restored;
  });
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  revalidateTrashInvoices();
  return { ok: true, data: undefined };
}

/** Permanently delete a trashed (draft) invoice — manager-only. */
export async function purgeInvoiceAction(id: string): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const organizationId = await getOrgId();
  const actor = await auditActor();
  await withOrg(organizationId, async (tx) => {
    await purgeInvoice(tx, organizationId, id);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'trash.purge',
      entityType: 'invoice',
      entityId: id,
    });
  });
  revalidateTrashInvoices();
  return { ok: true, data: undefined };
}
