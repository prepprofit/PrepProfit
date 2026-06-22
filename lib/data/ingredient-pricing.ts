import { and, desc, eq, isNull } from 'drizzle-orm';
import { ingredients, ingredientPriceHistory } from '@/lib/db/schema';
import type { Ingredient } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { lockActiveIngredientRow } from '@/lib/data/ingredients';
import { approvedPriceCents } from '@/lib/calculations/purchasePrice';
import type { Unit } from '@/lib/units';

/**
 * Ingredient pricing services (Sprint F2). The approved cost lives on
 * `ingredients.price_cents` (per kg / litre / piece). These functions are the ONLY
 * sanctioned way to touch it, and they all take a FOR UPDATE lock on the
 * ingredient first so observe / accept / manual-edit serialize (no racing the
 * "latest" history line). MUST run inside a `withOrg`/`runInOrg` transaction.
 */

export type PriceObservationSource = 'order' | 'quote' | 'import';

export type RecordPriceObservationInput = {
  ingredientId: string;
  source: PriceObservationSource;
  /** Pack quantity in `packUnit` (e.g. 5 for a 5 kg sack). */
  packSize: number;
  packUnit: Unit;
  /** Price of the whole pack, integer cents. */
  packPriceCents: number;
  actorUserId?: string | null;
  /** The supplier link/quote that produced this observation (Sprint 7 provenance). */
  ingredientSupplierId?: string | null;
  note?: string | null;
};

export type RecordPriceObservationResult =
  | { ok: true; ingredient: Ingredient; derivedPriceCents: number }
  | { ok: false; reason: 'not_found' };

/**
 * Record an observed pack price (quote/receipt/import) WITHOUT changing the
 * approved cost. Derives the per-unit cost (purchasePrice.ts), appends a history
 * row, and raises `pending_price_cents` for a manager to accept. Never mutates
 * `price_cents`. (The Sprint 7/8 receiving + quote flows call this.)
 */
export async function recordPriceObservation(
  db: TenantClient,
  organizationId: string,
  input: RecordPriceObservationInput,
): Promise<RecordPriceObservationResult> {
  const current = await lockActiveIngredientRow(db, organizationId, input.ingredientId);
  if (!current) return { ok: false, reason: 'not_found' };

  const derivedPriceCents = approvedPriceCents({
    packPriceCents: input.packPriceCents,
    packSize: input.packSize,
    packUnit: input.packUnit,
    dimension: current.dimension,
  });

  await db.insert(ingredientPriceHistory).values({
    organizationId,
    ingredientId: input.ingredientId,
    source: input.source,
    packSize: input.packSize.toString(),
    packUnit: input.packUnit,
    packPriceCents: input.packPriceCents,
    derivedPriceCents,
    accepted: false,
    actorUserId: input.actorUserId ?? null,
    ingredientSupplierId: input.ingredientSupplierId ?? null,
    note: input.note ?? null,
  });

  const [row] = await db
    .update(ingredients)
    .set({ pendingPriceCents: derivedPriceCents })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, input.ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  if (!row) return { ok: false, reason: 'not_found' };
  return { ok: true, ingredient: row, derivedPriceCents };
}

export type AcceptPendingCostResult =
  | { ok: true; ingredient: Ingredient }
  | { ok: false; reason: 'not_found' | 'nothing_pending' };

/**
 * Accept the pending observed cost: move `pending_price_cents` into `price_cents`,
 * clear the pending flag, clear `needs_pricing` (when the accepted value is real),
 * and mark the latest unaccepted history row `accepted`. Locked FOR UPDATE so the
 * "latest" row is deterministic. Manager-only + audited at the action layer.
 */
export async function acceptPendingCost(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<AcceptPendingCostResult> {
  const current = await lockActiveIngredientRow(db, organizationId, ingredientId);
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.pendingPriceCents == null) {
    return { ok: false, reason: 'nothing_pending' };
  }

  const accepted = current.pendingPriceCents;
  const [row] = await db
    .update(ingredients)
    .set({
      priceCents: accepted,
      pendingPriceCents: null,
      needsPricing: accepted > 0 ? false : current.needsPricing,
    })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .returning();
  if (!row) return { ok: false, reason: 'not_found' };

  const [latest] = await db
    .select({ id: ingredientPriceHistory.id })
    .from(ingredientPriceHistory)
    .where(
      and(
        eq(ingredientPriceHistory.organizationId, organizationId),
        eq(ingredientPriceHistory.ingredientId, ingredientId),
        eq(ingredientPriceHistory.accepted, false),
      ),
    )
    .orderBy(desc(ingredientPriceHistory.createdAt))
    .limit(1);
  if (latest) {
    await db
      .update(ingredientPriceHistory)
      .set({ accepted: true })
      .where(
        and(
          eq(ingredientPriceHistory.organizationId, organizationId),
          eq(ingredientPriceHistory.id, latest.id),
        ),
      );
  }

  return { ok: true, ingredient: row };
}

/**
 * Append a `source='manual'`, already-`accepted` history row for a directly
 * entered per-unit price (create-with-price or a manual price edit). The caller
 * already set `price_cents` and holds the ingredient lock — this only records the
 * trail. Pack columns are NULL (no pack for a direct per-unit price).
 */
export async function appendManualPriceHistory(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  priceCents: number,
  actorUserId: string | null,
  note?: string | null,
): Promise<void> {
  await db.insert(ingredientPriceHistory).values({
    organizationId,
    ingredientId,
    source: 'manual',
    packSize: null,
    packUnit: null,
    packPriceCents: null,
    derivedPriceCents: priceCents,
    accepted: true,
    actorUserId,
    note: note ?? null,
  });
}
