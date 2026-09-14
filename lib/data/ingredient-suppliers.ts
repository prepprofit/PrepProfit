import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { ingredients, ingredientSuppliers, organizationSettings, suppliers } from '@/lib/db/schema';
import type { IngredientSupplier, Supplier } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { lockActiveIngredientRow } from '@/lib/data/ingredients';
import { recordPriceObservation } from '@/lib/data/ingredient-pricing';
import { packPriceExclVatCents } from '@/lib/calculations/purchasePrice';
import { findOrCreateSupplierByName } from '@/lib/data/suppliers';
import { resolveVatRateBps } from '@/lib/data/vat-categories';
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
  /** The entry's own purchase VAT (bps); null = not set. */
  vatRateBps: number | null;
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
      vatRateBps: ingredientSuppliers.vatRateBps,
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
      vatRateBps: r.vatRateBps,
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

/**
 * What happened to the PRICE part of a supplier save. The supplier itself is always
 * assigned (unless the name/unit is invalid); pricing is optional and may be
 * completed later, so an incomplete price never blocks the save:
 *  - `saved`       a new whole-pack net price was stored;
 *  - `unchanged`   no price sent (or the same pack) — the stored price was kept;
 *  - `none`        no price is known for this link;
 *  - `needs_pack`  a price was entered but there's no complete pack size to price;
 *  - `needs_vat`   an incl.-VAT price was entered but no VAT rate is known.
 */
export type SupplierPriceStatus = 'saved' | 'unchanged' | 'none' | 'needs_pack' | 'needs_vat';

export type SetDefaultSupplierResult =
  | {
      status: 'ok';
      link: IngredientSupplier;
      supplier: Supplier;
      pendingRaised: boolean;
      priceStatus: SupplierPriceStatus;
      /** The VAT rate the save used to read an incl.-VAT price (null = unknown). */
      vatRateBps: number | null;
    }
  | { status: 'not_found' }
  | { status: 'supplier_inactive' }
  | { status: 'invalid_name' }
  | { status: 'pack_unit_mismatch' };

/** Numeric-or-null coercion for the stored numeric pack size (driver returns a string). */
function numOrNull(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The purchase VAT that applies to an ingredient's supplier entry, most specific
 * first: the entry's own rate → the ingredient's typed rate → the ingredient's
 * (explicitly chosen) VAT band → the business's configured default purchase VAT.
 * NULL when none is set — never the sales rate, never an invented statutory rate.
 */
export async function resolvePurchaseVatBps(
  db: TenantClient,
  organizationId: string,
  sources: { linkVatBps: number | null; ingredientVatBps: number | null; ingredientBandId: string | null },
): Promise<number | null> {
  if (sources.linkVatBps != null) return sources.linkVatBps;
  if (sources.ingredientVatBps != null) return sources.ingredientVatBps;
  if (sources.ingredientBandId != null) {
    const band = await resolveVatRateBps(db, organizationId, sources.ingredientBandId, { fallbackToDefault: false });
    if (band != null) return band;
  }
  const [settings] = await db
    .select({ vat: organizationSettings.defaultPurchaseVatBps })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return settings?.vat ?? null;
}

/**
 * Set (or update) the DEFAULT supplier for an ingredient — a PARTIAL update, all
 * under the caller's `withOrg` + a FOR UPDATE lock on the ingredient:
 *  1. find-or-create the supplier by name (rejects empty / refuses an archived one);
 *  2. merge the entry: a field OMITTED (`undefined`) keeps what this ingredient ⇄
 *     supplier entry already stores; `null` clears it; a value replaces it. Unknown
 *     stays NULL — never 0;
 *  3. validate the pack unit's dimension matches the ingredient;
 *  4. price (optional): stored as the whole-pack net price only when it can be
 *     derived honestly (complete pack; a VAT rate when entered incl. VAT). Otherwise
 *     the supplier still saves and `priceStatus` says what's missing;
 *  5. upsert the link, flip `is_default`, mirror the supplier name;
 *  6. raise a pending observed cost ONLY when a real pack price is stored AND the
 *     pack changed (§12.6). The ingredient's approved cost is never overwritten
 *     here — let alone with zero.
 */
export async function setDefaultSupplier(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
  input: IngredientSupplierInput,
): Promise<SetDefaultSupplierResult> {
  const ingredient = await lockActiveIngredientRow(db, organizationId, ingredientId);
  if (!ingredient) return { status: 'not_found' };

  const found = await findOrCreateSupplierByName(db, organizationId, input.supplierName);
  if (found.status === 'invalid_name') return { status: 'invalid_name' };
  if (found.status === 'inactive') return { status: 'supplier_inactive' };
  const supplier = found.supplier;

  // What this exact ingredient ⇄ supplier entry stores today (if anything).
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

  const keep = <T>(value: T | undefined, stored: T): T => (value === undefined ? stored : value);
  const priorSize = numOrNull(prior?.packSize ?? null);
  const priorUnit = (prior?.packUnit ?? null) as Unit | null;
  const priorUnits = prior?.unitsPerPack ?? 1;

  const newPackSize = keep(input.packSize, priorSize);
  const newPackUnit = keep(input.packUnit as Unit | null | undefined, priorUnit);
  const newUnitsPerPack = keep(input.unitsPerPack, priorUnits) ?? 1;
  const productName = keep(input.supplierProductName, prior?.supplierProductName ?? null);
  const sku = keep(input.supplierSku, prior?.supplierSku ?? null);

  if (newPackUnit && !isPackUnitCompatible(newPackUnit, ingredient.dimension)) {
    return { status: 'pack_unit_mismatch' };
  }

  // VAT: a deliberate rate (incl. 0%) is remembered on the entry; omitted keeps it.
  const linkVatBps = keep(input.vatRateBps, prior?.vatRateBps ?? null);
  // The legacy band travels only when the caller still sends one.
  const vatCategoryId =
    input.vatCategoryId === undefined
      ? ingredient.vatCategoryId
      : input.vatCategoryId === ''
        ? null
        : input.vatCategoryId;
  const taxRateBps = await resolvePurchaseVatBps(db, organizationId, {
    linkVatBps,
    ingredientVatBps: ingredient.vatRateBps,
    ingredientBandId: vatCategoryId,
  });

  const packComplete = newPackSize != null && newPackSize > 0 && newPackUnit != null && newUnitsPerPack > 0;
  const packSameAsPrior =
    prior != null && priorSize === newPackSize && priorUnit === newPackUnit && priorUnits === newUnitsPerPack;

  let newPackPriceCents: number | null;
  let priceStatus: SupplierPriceStatus;
  if (input.packPriceCents === undefined) {
    // No price sent: the stored price still describes the stored pack — keep it;
    // a different pack makes it meaningless, so it becomes unknown (not zero).
    newPackPriceCents = packSameAsPrior ? (prior?.packPriceCents ?? null) : null;
    priceStatus = newPackPriceCents == null ? 'none' : 'unchanged';
  } else if (input.packPriceCents === null) {
    newPackPriceCents = null;
    priceStatus = 'none';
  } else if (!packComplete) {
    newPackPriceCents = packSameAsPrior ? (prior?.packPriceCents ?? null) : null;
    priceStatus = 'needs_pack';
  } else {
    const net = packPriceExclVatCents({
      priceCents: input.packPriceCents,
      basis: input.priceBasis ?? 'pack',
      includesVat: input.priceIncludesVat ?? false,
      taxRateBps,
      unitsPerPack: newUnitsPerPack,
      packSize: newPackSize as number,
      packUnit: newPackUnit as Unit,
      dimension: ingredient.dimension,
    });
    if (net == null) {
      newPackPriceCents = packSameAsPrior ? (prior?.packPriceCents ?? null) : null;
      priceStatus = 'needs_vat';
    } else {
      newPackPriceCents = net;
      priceStatus = 'saved';
    }
  }

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

  const values = {
    packSize: newPackSize?.toString() ?? null,
    packUnit: newPackUnit,
    packPriceCents: newPackPriceCents,
    unitsPerPack: newUnitsPerPack,
    supplierProductName: productName,
    supplierSku: sku,
    vatRateBps: linkVatBps,
    isDefault: true,
  };
  const [link] = await db
    .insert(ingredientSuppliers)
    .values({ organizationId, ingredientId, supplierId: supplier.id, ...values })
    .onConflictDoUpdate({
      target: [
        ingredientSuppliers.organizationId,
        ingredientSuppliers.ingredientId,
        ingredientSuppliers.supplierId,
      ],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  if (!link) return { status: 'not_found' };

  // Remember how this supplier quotes prices, so the next ingredient prefills.
  if (input.priceBasis !== undefined || input.priceIncludesVat !== undefined) {
    await db
      .update(suppliers)
      .set({
        ...(input.priceBasis !== undefined ? { defaultPriceBasis: input.priceBasis } : {}),
        ...(input.priceIncludesVat !== undefined ? { defaultPriceIncludesVat: input.priceIncludesVat } : {}),
      })
      .where(and(eq(suppliers.organizationId, organizationId), eq(suppliers.id, supplier.id)));
  }

  // Mirror the supplier name into the legacy column (transition contract §6). A
  // deliberate VAT rate also becomes the ingredient's own rate, so its other
  // supplier entries default to it.
  await db
    .update(ingredients)
    .set({
      supplier: supplier.name,
      vatCategoryId,
      ...(input.vatRateBps != null ? { vatRateBps: input.vatRateBps } : {}),
    })
    .where(and(eq(ingredients.organizationId, organizationId), eq(ingredients.id, ingredientId)));

  let pendingRaised = false;
  const packChanged =
    priorSize !== newPackSize ||
    priorUnit !== newPackUnit ||
    priorUnits !== newUnitsPerPack ||
    (prior?.packPriceCents ?? null) !== newPackPriceCents;

  if (priceStatus === 'saved' && newPackPriceCents != null && newPackSize != null && newPackUnit != null && packChanged) {
    await recordPriceObservation(db, organizationId, {
      ingredientId,
      source: 'quote',
      // The price trail records the quantity actually purchased (4 × 1.65 kg → 6.6).
      packSize: newUnitsPerPack * newPackSize,
      packUnit: newPackUnit,
      packPriceCents: newPackPriceCents,
      ingredientSupplierId: link.id,
    });
    pendingRaised = true;
  }

  return { status: 'ok', link, supplier, pendingRaised, priceStatus, vatRateBps: taxRateBps };
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
