import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { ingredients, ingredientSuppliers, suppliers } from '@/lib/db/schema';
import type { IngredientSupplier, Supplier } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { lockActiveIngredientRow } from '@/lib/data/ingredients';
import { recordPriceObservation } from '@/lib/data/ingredient-pricing';
import { packPriceExclVatCents } from '@/lib/calculations/purchasePrice';
import { findOrCreateSupplierByName } from '@/lib/data/suppliers';
import { isPackUnitCompatible } from '@/lib/suppliers/display-name';
import { normalizeIngredientName } from '@/lib/import/resolveIngredient';
import type { SupplierPackCandidate } from '@/lib/ai/supplier-pack-resolve';
import type { Unit } from '@/lib/units';
import type { IngredientSupplierInput } from '@/lib/validation/suppliers';

/**
 * Ingredient ⇄ supplier links (Sprint 7). The DEFAULT link carries the pack an
 * ingredient is bought in; setting/updating its price raises a pending observed
 * cost (never mutates the approved price). Always org-scoped (RULE #1) and MUST
 * run inside a `withOrg` transaction (RLS + the ingredient FOR UPDATE lock).
 */

/** A link joined to its supplier (for the ingredient editor + detail views). */
export type IngredientSupplierLink = {
  link: IngredientSupplier;
  supplier: Supplier;
};

export async function listIngredientSuppliers(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<IngredientSupplierLink[]> {
  const rows = await db
    .select({ link: ingredientSuppliers, supplier: suppliers })
    .from(ingredientSuppliers)
    .innerJoin(
      suppliers,
      and(
        eq(suppliers.organizationId, organizationId),
        eq(suppliers.id, ingredientSuppliers.supplierId),
      ),
    )
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.ingredientId, ingredientId),
      ),
    )
    .orderBy(asc(suppliers.name));
  return rows;
}

/** An ingredient a supplier provides + the pack on the link (supplier detail page). */
export type SupplierIngredientRow = {
  ingredientId: string;
  ingredientName: string;
  packSize: number | null;
  packUnit: string | null;
  packPriceCents: number | null;
  isDefault: boolean;
};

/**
 * Active ingredients linked to a supplier, with each link's pack. Used by the
 * supplier detail page (manager-only). Trashed ingredients are excluded.
 */
export async function listIngredientsForSupplier(
  db: TenantClient,
  organizationId: string,
  supplierId: string,
): Promise<SupplierIngredientRow[]> {
  const rows = await db
    .select({
      ingredientId: ingredients.id,
      ingredientName: ingredients.name,
      packSize: ingredientSuppliers.packSize,
      packUnit: ingredientSuppliers.packUnit,
      packPriceCents: ingredientSuppliers.packPriceCents,
      isDefault: ingredientSuppliers.isDefault,
    })
    .from(ingredientSuppliers)
    .innerJoin(
      ingredients,
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientSuppliers.ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.supplierId, supplierId),
      ),
    )
    .orderBy(asc(ingredients.name));

  return rows.map((r) => ({
    ingredientId: r.ingredientId,
    ingredientName: r.ingredientName,
    packSize: numOrNull(r.packSize),
    packUnit: r.packUnit,
    packPriceCents: r.packPriceCents,
    isDefault: r.isDefault,
  }));
}

export async function getDefaultLink(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<IngredientSupplierLink | null> {
  const rows = await db
    .select({ link: ingredientSuppliers, supplier: suppliers })
    .from(ingredientSuppliers)
    .innerJoin(
      suppliers,
      and(
        eq(suppliers.organizationId, organizationId),
        eq(suppliers.id, ingredientSuppliers.supplierId),
      ),
    )
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.ingredientId, ingredientId),
        eq(ingredientSuppliers.isDefault, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Whether any of the ingredient's supplier-link packs use a unit that would be
 * INCOMPATIBLE with `dimension` (§12.9). Used to block changing an ingredient's
 * dimension while a pack (e.g. a kg pack) would no longer make sense. Links with a
 * NULL pack unit are ignored (no dimension to conflict).
 */
export async function hasIncompatiblePacks(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  dimension: 'weight' | 'volume' | 'count',
): Promise<boolean> {
  const rows = await db
    .select({ packUnit: ingredientSuppliers.packUnit })
    .from(ingredientSuppliers)
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.ingredientId, ingredientId),
      ),
    );
  return rows.some(
    (r) => r.packUnit != null && !isPackUnitCompatible(r.packUnit as Unit, dimension),
  );
}

/** The default-link summary the ingredient editor prefills (no N+1 — batch loaded). */
export type DefaultSupplierSummary = {
  supplierName: string;
  packSize: number | null;
  packUnit: string | null;
  /** Whole-pack price EXCL. VAT (the stored canonical shape). */
  packPriceCents: number | null;
  unitsPerPack: number;
  supplierProductName: string | null;
  supplierSku: string | null;
};

/**
 * Default supplier link (name + pack) for every given ingredient id, in ONE query
 * (avoids N+1 when the ingredient grid prefills its per-row supplier dialog). Only
 * ingredients WITH a default link appear in the map.
 */
export async function loadDefaultLinksByIngredient(
  db: TenantClient,
  organizationId: string,
  ingredientIds: string[],
): Promise<Map<string, DefaultSupplierSummary>> {
  const map = new Map<string, DefaultSupplierSummary>();
  if (ingredientIds.length === 0) return map;

  const rows = await db
    .select({
      ingredientId: ingredientSuppliers.ingredientId,
      supplierName: suppliers.name,
      packSize: ingredientSuppliers.packSize,
      packUnit: ingredientSuppliers.packUnit,
      packPriceCents: ingredientSuppliers.packPriceCents,
      unitsPerPack: ingredientSuppliers.unitsPerPack,
      supplierProductName: ingredientSuppliers.supplierProductName,
      supplierSku: ingredientSuppliers.supplierSku,
    })
    .from(ingredientSuppliers)
    .innerJoin(
      suppliers,
      and(
        eq(suppliers.organizationId, organizationId),
        eq(suppliers.id, ingredientSuppliers.supplierId),
      ),
    )
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.isDefault, true),
        inArray(ingredientSuppliers.ingredientId, ingredientIds),
      ),
    );

  for (const r of rows) {
    map.set(r.ingredientId, {
      supplierName: r.supplierName,
      packSize: numOrNull(r.packSize),
      packUnit: r.packUnit,
      packPriceCents: r.packPriceCents,
      unitsPerPack: r.unitsPerPack,
      supplierProductName: r.supplierProductName,
      supplierSku: r.supplierSku,
    });
  }
  return map;
}

/**
 * Candidate supplier packs for every ACTIVE ingredient that has a supplier link,
 * keyed by the ingredient's NORMALIZED name (the same key the import resolver uses).
 * Phase 6 (AI photo extraction): the extraction route passes this to
 * `applySupplierPacks` so a descriptor line (`1 block butter`) can infer its pack size
 * from the org's own supplier data. Trashed ingredients are excluded; a name with
 * several ingredients merges their packs (the resolver then refuses if they disagree).
 */
export async function loadSupplierPacksByIngredientName(
  db: TenantClient,
  organizationId: string,
): Promise<Map<string, SupplierPackCandidate[]>> {
  const rows = await db
    .select({
      name: ingredients.name,
      packSize: ingredientSuppliers.packSize,
      packUnit: ingredientSuppliers.packUnit,
    })
    .from(ingredientSuppliers)
    .innerJoin(
      ingredients,
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientSuppliers.ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .where(eq(ingredientSuppliers.organizationId, organizationId));

  const map = new Map<string, SupplierPackCandidate[]>();
  for (const r of rows) {
    const key = normalizeIngredientName(r.name);
    if (key === '') continue;
    const list = map.get(key) ?? [];
    list.push({ packSize: numOrNull(r.packSize), packUnit: r.packUnit });
    map.set(key, list);
  }
  return map;
}

export type SetDefaultSupplierResult =
  | { status: 'ok'; link: IngredientSupplier; supplier: Supplier; pendingRaised: boolean }
  | { status: 'not_found' }
  | { status: 'supplier_inactive' }
  | { status: 'invalid_name' }
  | { status: 'pack_unit_mismatch' }
  | { status: 'vat_rate_required' };

/** Numeric-or-null coercion for the stored numeric pack size (driver returns a string). */
function numOrNull(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Set (or update) the DEFAULT supplier for an ingredient — the dual-write
 * transaction (transition contract §5/§6). All under the caller's `withOrg` + a
 * FOR UPDATE lock on the ingredient:
 *  1. find-or-create the supplier by name (rejects empty / refuses an archived one);
 *  2. validate the pack unit's dimension matches the ingredient;
 *  3. upsert the link and flip `is_default` (clearing any prior default);
 *  4. mirror the supplier name into the legacy `ingredients.supplier` column;
 *  5. raise a pending observed cost ONLY when a real pack price is present AND the
 *     pack changed (§12.6) — an unchanged pack is a no-op (no new history, no
 *     re-opened pending).
 *
 * `taxRateBps` is the org's VAT rate (server-derived, never client input). It is only
 * needed when the quote `priceIncludesVat` — the net price is otherwise unknowable and
 * we refuse rather than guess 0% (`vat_rate_required`).
 */
export async function setDefaultSupplier(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  input: IngredientSupplierInput,
  taxRateBps: number | null = null,
): Promise<SetDefaultSupplierResult> {
  const ingredient = await lockActiveIngredientRow(db, organizationId, ingredientId);
  if (!ingredient) return { status: 'not_found' };

  const found = await findOrCreateSupplierByName(db, organizationId, input.supplierName);
  if (found.status === 'invalid_name') return { status: 'invalid_name' };
  if (found.status === 'inactive') return { status: 'supplier_inactive' };
  const supplier = found.supplier;

  // The pack's new state (a missing field clears it; Zod kept size+unit coupled).
  // `packSize` is the size of ONE inner unit; the purchase holds `unitsPerPack` of them.
  const newPackSize = input.packSize ?? null;
  const newPackUnit = (input.packUnit ?? null) as Unit | null;
  const newUnitsPerPack = input.unitsPerPack ?? 1;

  if (newPackUnit && !isPackUnitCompatible(newPackUnit, ingredient.dimension)) {
    return { status: 'pack_unit_mismatch' };
  }

  // Normalize the quoted price into the stored shape: whole pack, EXCL. VAT. The
  // client sends what the manager typed plus how to read it; the maths lives here.
  let newPackPriceCents: number | null = null;
  if (input.packPriceCents != null && newPackSize != null && newPackUnit != null) {
    const net = packPriceExclVatCents({
      priceCents: input.packPriceCents,
      basis: input.priceBasis ?? 'pack',
      includesVat: input.priceIncludesVat ?? false,
      taxRateBps,
      unitsPerPack: newUnitsPerPack,
      packSize: newPackSize,
      packUnit: newPackUnit,
      dimension: ingredient.dimension,
    });
    if (net == null) return { status: 'vat_rate_required' };
    newPackPriceCents = net;
  }

  // Prior state of this exact link (if any), to detect a real pack change.
  const [prior] = await db
    .select()
    .from(ingredientSuppliers)
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.ingredientId, ingredientId),
        eq(ingredientSuppliers.supplierId, supplier.id),
      ),
    )
    .limit(1);

  // Clear the current default FIRST so the partial unique (≤1 default/ingredient)
  // is never momentarily violated when we set this link's default flag.
  await db
    .update(ingredientSuppliers)
    .set({ isDefault: false })
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.ingredientId, ingredientId),
        eq(ingredientSuppliers.isDefault, true),
      ),
    );

  const [link] = await db
    .insert(ingredientSuppliers)
    .values({
      organizationId,
      ingredientId,
      supplierId: supplier.id,
      packSize: newPackSize?.toString() ?? null,
      packUnit: newPackUnit,
      packPriceCents: newPackPriceCents,
      unitsPerPack: newUnitsPerPack,
      supplierProductName: input.supplierProductName ?? null,
      supplierSku: input.supplierSku ?? null,
      isDefault: true,
    })
    .onConflictDoUpdate({
      target: [
        ingredientSuppliers.organizationId,
        ingredientSuppliers.ingredientId,
        ingredientSuppliers.supplierId,
      ],
      set: {
        packSize: newPackSize?.toString() ?? null,
        packUnit: newPackUnit,
        packPriceCents: newPackPriceCents,
        unitsPerPack: newUnitsPerPack,
        supplierProductName: input.supplierProductName ?? null,
        supplierSku: input.supplierSku ?? null,
        isDefault: true,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!link) return { status: 'not_found' };

  // Remember how this supplier quotes prices, so the next ingredient prefills both
  // selects. Display convenience only — the stored price stays whole-pack net.
  if (input.priceBasis !== undefined || input.priceIncludesVat !== undefined) {
    await db
      .update(suppliers)
      .set({
        ...(input.priceBasis !== undefined
          ? { defaultPriceBasis: input.priceBasis }
          : {}),
        ...(input.priceIncludesVat !== undefined
          ? { defaultPriceIncludesVat: input.priceIncludesVat }
          : {}),
      })
      .where(
        and(
          eq(suppliers.organizationId, organizationId),
          eq(suppliers.id, supplier.id),
        ),
      );
  }

  // Mirror the supplier name into the legacy column (transition contract §6).
  await db
    .update(ingredients)
    .set({ supplier: supplier.name })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientId),
      ),
    );

  // Raise a pending observed cost only when a real price is present AND the pack
  // actually changed (§12.6).
  let pendingRaised = false;
  const packChanged =
    numOrNull(prior?.packSize ?? null) !== newPackSize ||
    (prior?.packUnit ?? null) !== newPackUnit ||
    (prior?.unitsPerPack ?? 1) !== newUnitsPerPack ||
    (prior?.packPriceCents ?? null) !== newPackPriceCents;

  if (
    newPackPriceCents != null &&
    newPackSize != null &&
    newPackUnit != null &&
    packChanged
  ) {
    await recordPriceObservation(db, organizationId, {
      ingredientId,
      source: 'quote',
      // The price trail records the quantity actually purchased (4 × 1.65 kg → 6.6),
      // so the derived cost per kg reads back honestly from one pair of numbers.
      packSize: newUnitsPerPack * newPackSize,
      packUnit: newPackUnit,
      packPriceCents: newPackPriceCents,
      ingredientSupplierId: link.id,
    });
    pendingRaised = true;
  }

  return { status: 'ok', link, supplier, pendingRaised };
}

/**
 * Remove the ingredient's DEFAULT supplier link and clear the legacy
 * `ingredients.supplier` text. Returns whether a default link was present.
 */
export async function clearDefaultSupplier(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<boolean> {
  if (!(await lockActiveIngredientRow(db, organizationId, ingredientId))) {
    return false;
  }
  const [removed] = await db
    .delete(ingredientSuppliers)
    .where(
      and(
        eq(ingredientSuppliers.organizationId, organizationId),
        eq(ingredientSuppliers.ingredientId, ingredientId),
        eq(ingredientSuppliers.isDefault, true),
      ),
    )
    .returning({ id: ingredientSuppliers.id });
  if (!removed) return false;

  await db
    .update(ingredients)
    .set({ supplier: null })
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientId),
      ),
    );
  return true;
}
