'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  createIngredient,
  lockActiveIngredientRow,
  toKitchenIngredient,
  trashIngredient,
  updateIngredient,
  type KitchenIngredient,
} from '@/lib/data/ingredients';
import {
  acceptPendingCost,
  appendManualPriceHistory,
} from '@/lib/data/ingredient-pricing';
import {
  clearDefaultSupplier,
  hasIncompatiblePacks,
  setDefaultSupplier,
} from '@/lib/data/ingredient-suppliers';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  ingredientSchema,
  kitchenIngredientSchema,
} from '@/lib/validation/ingredients';
import { ingredientSupplierSchema } from '@/lib/validation/suppliers';
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

/**
 * The numeric `priceCents` a (kitchen) client tried to send, if any — used to
 * refuse a FORGED price change with FORBIDDEN rather than silently dropping it. The
 * kitchen schema strips price, so we peek at the raw payload. Non-numeric → ignored.
 */
function forgedPriceCents(input: unknown): number | undefined {
  if (typeof input === 'object' && input !== null && 'priceCents' in input) {
    const value = (input as { priceCents?: unknown }).priceCents;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export async function createIngredientAction(
  input: unknown,
): Promise<ActionResult<Ingredient | KitchenIngredient>> {
  const organizationId = await getOrgId();
  const actor = await auditActor();

  // KITCHEN: operational create only — the server forces priceCents=0 +
  // needsPricing=true and never reads a client-sent price (Sprint F4, decision #4).
  if (!(await isManager())) {
    const parsed = kitchenIngredientSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
    const row = await withOrg(organizationId, (tx) =>
      createIngredient(tx, organizationId, {
        name: parsed.data.name,
        dimension: parsed.data.dimension,
        priceCents: 0,
        needsPricing: true,
      }),
    );
    revalidateIngredientConsumers();
    return { ok: true, data: toKitchenIngredient(row) };
  }

  // MANAGER: full create, may set an opening price.
  const parsed = ingredientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  const row = await withOrg(organizationId, async (tx) => {
    const created = await createIngredient(tx, organizationId, parsed.data);
    // A real opening price gets a `source='manual'` history row (the price trail,
    // Sprint F2).
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
): Promise<ActionResult<Ingredient | KitchenIngredient>> {
  const organizationId = await getOrgId();
  const manager = await isManager();
  const actor = await auditActor();

  // KITCHEN: operational edit only (name/dimension/supplier). The stored price is
  // preserved and never received from the client (Sprint F4). A price change is a
  // financial action → FORBIDDEN before the write (the kitchen UI never sends a
  // price; a forged one is refused, not silently dropped). Changing the `dimension`
  // of an ALREADY-PRICED ingredient re-bases what its price means (per kg vs litre
  // vs piece), so that is manager-only too.
  if (!manager) {
    const parsed = kitchenIngredientSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
    const forgedPrice = forgedPriceCents(input);
    const outcome = await withOrg(organizationId, async (tx) => {
      const current = await lockActiveIngredientRow(tx, organizationId, id);
      if (!current) return 'not_found' as const;
      if (forgedPrice !== undefined && forgedPrice !== current.priceCents) {
        return 'forbidden' as const;
      }
      if (parsed.data.dimension !== current.dimension && current.priceCents > 0) {
        return 'forbidden' as const;
      }
      // Block a dimension change while a supplier pack would become unit-incompatible
      // (e.g. a kg pack on a now-volume ingredient) — §12.9.
      if (
        parsed.data.dimension !== current.dimension &&
        (await hasIncompatiblePacks(tx, organizationId, id, parsed.data.dimension))
      ) {
        return 'pack_mismatch' as const;
      }
      const row = await updateIngredient(tx, organizationId, id, {
        name: parsed.data.name,
        dimension: parsed.data.dimension,
        // Preserve all financial state verbatim. `supplier` is owned by the link
        // flow (Sprint 7) — never set from this payload, so the mirror is preserved.
        priceCents: current.priceCents,
        needsPricing: current.needsPricing,
        pendingPriceCents: current.pendingPriceCents,
      });
      return row ?? ('not_found' as const);
    });
    if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
    if (outcome === 'forbidden') return { ok: false, code: 'FORBIDDEN' };
    if (outcome === 'pack_mismatch') return { ok: false, code: 'PACK_UNIT_MISMATCH' };
    revalidateIngredientConsumers();
    return { ok: true, data: toKitchenIngredient(outcome) };
  }

  // MANAGER: full edit, may change the price (Sprint F2 manager price-gate).
  const parsed = ingredientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
  const outcome = await withOrg(organizationId, async (tx) => {
    // Lock the row (serializes a manual edit against accept/observe — F2).
    const current = await lockActiveIngredientRow(tx, organizationId, id);
    if (!current) return 'not_found' as const;

    // Block a dimension change while a supplier pack would become unit-incompatible
    // (e.g. a kg pack on a now-volume ingredient) — §12.9.
    if (
      parsed.data.dimension !== current.dimension &&
      (await hasIncompatiblePacks(tx, organizationId, id, parsed.data.dimension))
    ) {
      return 'pack_mismatch' as const;
    }

    const priceChanged = parsed.data.priceCents !== current.priceCents;

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
  if (outcome === 'pack_mismatch') return { ok: false, code: 'PACK_UNIT_MISMATCH' };
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

/**
 * Set (or update) the DEFAULT supplier on an ingredient (Sprint 7). MANAGER-ONLY —
 * returns FORBIDDEN before any data access (suppliers + pricing are financial,
 * F4). The dual-write transaction (find-or-create supplier, upsert the link, mirror
 * the legacy column, raise a pending observed cost when the pack price changed) and
 * the audit event run in one `withOrg` tx. Audit metadata is ids + non-PII pack
 * descriptors only — never supplier contact details.
 */
export async function setIngredientSupplierAction(
  ingredientId: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = ingredientSupplierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  // The VAT rate is server-derived from the ingredient's purchase VAT category
  // inside the transaction — never a client-sent rate.
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await setDefaultSupplier(
      tx,
      organizationId,
      ingredientId,
      parsed.data,
    );
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'ingredient.supplierSet',
      entityType: 'ingredient',
      entityId: ingredientId,
      metadata: {
        supplierId: result.supplier.id,
        packSize: parsed.data.packSize ?? null,
        packUnit: parsed.data.packUnit ?? null,
        unitsPerPack: parsed.data.unitsPerPack ?? 1,
        // The STORED whole-pack net price, not the raw quote.
        packPriceCents: result.link.packPriceCents,
        pendingRaised: result.pendingRaised,
      },
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'supplier_inactive') return { ok: false, code: 'SUPPLIER_INACTIVE' };
  if (outcome === 'invalid_name') return { ok: false, code: 'INVALID_INPUT' };
  if (outcome === 'vat_rate_required') {
    return { ok: false, code: 'VAT_RATE_REQUIRED' };
  }
  if (outcome === 'pack_unit_mismatch') {
    return { ok: false, code: 'PACK_UNIT_MISMATCH' };
  }
  revalidateIngredientConsumers();
  revalidatePath('/suppliers');
  return { ok: true, data: undefined };
}

/**
 * Remove the ingredient's DEFAULT supplier link and clear the legacy mirror
 * (Sprint 7). MANAGER-ONLY — FORBIDDEN before data. Audited.
 */
export async function clearIngredientSupplierAction(
  ingredientId: string,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const cleared = await withOrg(organizationId, async (tx) => {
    const removed = await clearDefaultSupplier(tx, organizationId, ingredientId);
    if (removed) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: 'ingredient.supplierClear',
        entityType: 'ingredient',
        entityId: ingredientId,
      });
    }
    return removed;
  });

  if (!cleared) return { ok: false, code: 'NOT_FOUND' };
  revalidateIngredientConsumers();
  revalidatePath('/suppliers');
  return { ok: true, data: undefined };
}
