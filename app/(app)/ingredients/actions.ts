'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { unexpected } from '@/lib/observability';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  createIngredient,
  lockActiveIngredientRow,
  toKitchenIngredient,
  trashIngredient,
  listIngredientTypeLocks,
  updateIngredient,
  type IngredientUsage,
  type KitchenIngredient,
} from '@/lib/data/ingredients';
import {
  acceptPendingCost,
  appendManualPriceHistory,
} from '@/lib/data/ingredient-pricing';
import {
  clearDefaultSupplier,
  getSupplierProductIdentity,
  hasIncompatiblePacks,
  setDefaultSupplier,
  type DefaultSupplierSummary,
  type SupplierPriceStatus,
  type SupplierProductIdentity,
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
      if (
        parsed.data.dimension !== current.dimension &&
        (await listIngredientTypeLocks(tx, organizationId, [id])).has(id)
      ) {
        return 'type_in_use' as const;
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
    if (outcome === 'type_in_use') return { ok: false, code: 'INGREDIENT_TYPE_IN_USE' };
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
    // …and while recipes, dishes or stock hold quantities in the current unit.
    if (
      parsed.data.dimension !== current.dimension &&
      (await listIngredientTypeLocks(tx, organizationId, [id])).has(id)
    ) {
      return 'type_in_use' as const;
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
  if (outcome === 'type_in_use') return { ok: false, code: 'INGREDIENT_TYPE_IN_USE' };
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
export type DeleteIngredientResult =
  | { status: 'trashed' }
  | { status: 'in_use'; usage: IngredientUsage };

export async function deleteIngredientAction(
  id: string,
): Promise<ActionResult<DeleteIngredientResult>> {
  if (typeof id !== 'string' || id.trim() === '') return { ok: false, code: 'INVALID_INPUT' };
  try {
    const organizationId = await getOrgId();
    const outcome = await withOrg(organizationId, (tx) =>
      trashIngredient(tx, organizationId, id),
    );
    if (outcome.status === 'not_found') {
      return { ok: false, code: 'NOT_FOUND' };
    }
    // A real dependency is an answer, not a failure: the UI names what uses it.
    if (outcome.status === 'in_use') {
      return { ok: true, data: { status: 'in_use', usage: outcome.usage } };
    }
    revalidateIngredientConsumers();
    revalidatePath('/trash');
    return { ok: true, data: { status: 'trashed' } };
  } catch (error) {
    return unexpected('deleteIngredientAction', error);
  }
}

/**
 * Set (or update) the DEFAULT supplier on an ingredient (Sprint 7). MANAGER-ONLY —
 * returns FORBIDDEN before any data access (suppliers + pricing are financial,
 * F4). The dual-write transaction (find-or-create supplier, upsert the link, mirror
 * the legacy column, raise a pending observed cost when the pack price changed) and
 * the audit event run in one `withOrg` tx. Audit metadata is ids + non-PII pack
 * descriptors only — never supplier contact details.
 */
export type SetIngredientSupplierResult = {
  priceStatus: SupplierPriceStatus;
  pendingRaised: boolean;
  /** The stored entry, so the editor reopens exactly as saved. */
  link: DefaultSupplierSummary;
};

export async function setIngredientSupplierAction(
  ingredientId: string,
  input: unknown,
): Promise<ActionResult<SetIngredientSupplierResult>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = ingredientSupplierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  // The VAT rate used to read an incl.-VAT quote is resolved server-side inside the
  // transaction (entry → ingredient → business default purchase VAT).
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await setDefaultSupplier(tx, organizationId, ingredientId, parsed.data);
    if (result.status !== 'ok') return result;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'ingredient.supplierSet',
      entityType: 'ingredient',
      entityId: ingredientId,
      metadata: {
        supplierId: result.supplier.id,
        packSize: result.link.packSize == null ? null : Number(result.link.packSize),
        packUnit: result.link.packUnit,
        unitsPerPack: result.link.unitsPerPack,
        // The STORED whole-pack net price, not the raw quote.
        packPriceCents: result.link.packPriceCents,
        priceStatus: result.priceStatus,
        pendingRaised: result.pendingRaised,
      },
    });
    return result;
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'supplier_inactive') return { ok: false, code: 'SUPPLIER_INACTIVE' };
  if (outcome.status === 'invalid_name') return { ok: false, code: 'INVALID_INPUT' };
  if (outcome.status === 'pack_unit_mismatch') return { ok: false, code: 'PACK_UNIT_MISMATCH' };
  revalidateIngredientConsumers();
  revalidatePath('/suppliers');
  return {
    ok: true,
    data: {
      priceStatus: outcome.priceStatus,
      pendingRaised: outcome.pendingRaised,
      link: {
        supplierName: outcome.supplier.name,
        packSize: outcome.link.packSize == null ? null : Number(outcome.link.packSize),
        packUnit: outcome.link.packUnit,
        packPriceCents: outcome.link.packPriceCents,
        unitsPerPack: outcome.link.unitsPerPack,
        supplierProductName: outcome.link.supplierProductName,
        supplierSku: outcome.link.supplierSku,
        vatRateBps: outcome.link.vatRateBps,
      },
    },
  };
}

const supplierIdentityLookupSchema = z.object({
  ingredientId: z.string().trim().min(1).max(64),
  supplierName: z.string().trim().min(1).max(120),
});

/**
 * The product name and code this ingredient already has with a given supplier, so
 * the supplier editor shows that supplier's own identifiers when the chef switches
 * supplier. Read-only; MANAGER-ONLY — FORBIDDEN before data. `null` = not linked yet.
 */
export async function getSupplierProductIdentityAction(
  ingredientId: string,
  supplierName: string,
): Promise<ActionResult<SupplierProductIdentity | null>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };

  const parsed = supplierIdentityLookupSchema.safeParse({ ingredientId, supplierName });
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const identity = await withOrg(organizationId, (tx) =>
    getSupplierProductIdentity(tx, organizationId, parsed.data.ingredientId, parsed.data.supplierName),
  );
  return { ok: true, data: identity };
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
