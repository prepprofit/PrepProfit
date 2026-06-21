'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  createIngredient,
  lockActiveIngredientRow,
  trashIngredient,
  updateIngredient,
} from '@/lib/data/ingredients';
import {
  acceptPendingCost,
  appendManualPriceHistory,
} from '@/lib/data/ingredient-pricing';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import { ingredientSchema } from '@/lib/validation/ingredients';
import type { ActionResult } from '@/lib/action-result';
import type { Ingredient } from '@/lib/db/schema';

/**
 * Server Actions for the Ingredients module. RULE #1: the org id is derived from
 * Clerk on the server (never the client), every write runs inside `withOrg` so
 * RLS is active, and all input is validated with Zod on the server.
 */

/** Recipe cost is derived from ingredient prices, so refresh recipes too. */
function revalidateIngredientConsumers(): void {
  revalidatePath('/ingredients');
  revalidatePath('/recipes');
}

export async function createIngredientAction(
  input: unknown,
): Promise<ActionResult<Ingredient>> {
  const parsed = ingredientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const row = await withOrg(organizationId, async (tx) => {
    const created = await createIngredient(tx, organizationId, parsed.data);
    // A real opening price gets a `source='manual'` history row (the price trail,
    // Sprint F2). Create-with-price RBAC is completed in F4.
    if (created.priceCents > 0) {
      await appendManualPriceHistory(
        tx,
        organizationId,
        created.id,
        created.priceCents,
        actor.userId,
      );
    }
    return created;
  });
  revalidateIngredientConsumers();
  return { ok: true, data: row };
}

export async function updateIngredientAction(
  id: string,
  input: unknown,
): Promise<ActionResult<Ingredient>> {
  const parsed = ingredientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  // Changing price_cents is a financial action → manager-only (Sprint F2; the UI
  // hides the field from kitchen in F4). Non-price edits (name/supplier) stay open.
  const manager = await isManager();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    // Lock the row (serializes a manual edit against accept/observe — F2).
    const current = await lockActiveIngredientRow(tx, organizationId, id);
    if (!current) return 'not_found' as const;

    const priceChanged = parsed.data.priceCents !== current.priceCents;
    if (priceChanged && !manager) return 'forbidden' as const;

    const row = await updateIngredient(tx, organizationId, id, {
      ...parsed.data,
      // A real price clears the import "needs pricing" flag (Sprint 4.6).
      needsPricing: parsed.data.priceCents > 0 ? false : current.needsPricing,
      // A manual price supersedes any pending observed cost.
      pendingPriceCents: priceChanged ? null : current.pendingPriceCents,
    });
    if (!row) return 'not_found' as const;

    if (priceChanged) {
      await appendManualPriceHistory(
        tx,
        organizationId,
        id,
        parsed.data.priceCents,
        actor.userId,
      );
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ingredient.priceUpdate',
        entityType: 'ingredient',
        entityId: id,
        metadata: {
          oldPriceCents: current.priceCents,
          newPriceCents: parsed.data.priceCents,
        },
      });
    }
    return row;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'forbidden') return { ok: false, code: 'FORBIDDEN' };
  revalidateIngredientConsumers();
  return { ok: true, data: outcome };
}

/**
 * Accept the pending observed cost (Sprint F2): move `pending_price_cents` into the
 * approved `price_cents`. Manager-only — returns FORBIDDEN before any data access —
 * and audited (`ingredient.priceAccept`) in the same transaction.
 */
export async function acceptPendingCostAction(
  id: string,
): Promise<ActionResult<Ingredient>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await acceptPendingCost(tx, organizationId, id);
    if (!result.ok) return result.reason;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'ingredient.priceAccept',
      entityType: 'ingredient',
      entityId: id,
      metadata: { newPriceCents: result.ingredient.priceCents },
    });
    return result.ingredient;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  // Nothing pending (e.g. a double-click after it was already accepted).
  if (outcome === 'nothing_pending') return { ok: false, code: 'INVALID_INPUT' };
  revalidateIngredientConsumers();
  return { ok: true, data: outcome };
}

/**
 * Moves an ingredient to the trash (soft-delete). Blocked if any ACTIVE recipe
 * still uses it — the row is locked FOR UPDATE first, then the in-use check and
 * the soft-delete run in one transaction, so a recipe cannot start using it
 * between the two (addRecipeIngredient takes the same lock). Restorable for 30
 * days via /trash.
 */
export async function deleteIngredientAction(
  id: string,
): Promise<ActionResult> {
  const organizationId = await getOrgId();
  const outcome = await withOrg(organizationId, (tx) =>
    trashIngredient(tx, organizationId, id),
  );

  if (outcome.status === 'in_use') {
    return { ok: false, code: 'INGREDIENT_IN_USE' };
  }
  if (outcome.status === 'not_found') {
    return { ok: false, code: 'NOT_FOUND' };
  }
  revalidateIngredientConsumers();
  revalidatePath('/trash');
  return { ok: true, data: undefined };
}
