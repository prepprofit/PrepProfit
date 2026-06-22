import { and, eq, isNotNull } from 'drizzle-orm';
import { ingredients, ingredientSuppliers, suppliers } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { normalizeSupplierName } from '@/lib/suppliers/normalize';
import { pickSupplierDisplayName } from '@/lib/suppliers/display-name';
import { getDefaultLink } from '@/lib/data/ingredient-suppliers';

/**
 * Sprint 7 supplier backfill — the per-ORG transform (the script in
 * scripts/backfill-suppliers.ts fans this out over Clerk orgs inside `withOrg`).
 * Kept here, not in the script, so it is unit-testable and the script stays a thin
 * RLS-safe driver.
 *
 * IDEMPOTENT (§12.1/§12.2): group non-blank `ingredients.supplier` by the F6
 * normalized key; create one supplier per key (display name = the deterministic
 * `pickSupplierDisplayName`); per ingredient, KEEP any existing default link (only
 * sync the legacy mirror to that supplier's name) else create a default link and
 * set the legacy mirror to the chosen canonical name. Re-runnable with no dupes.
 */
export type SupplierBackfillStats = {
  suppliersCreated: number;
  linksCreated: number;
  linksKept: number;
  legacySynced: number;
};

export async function backfillSuppliersForOrg(
  db: TenantClient,
  organizationId: string,
): Promise<SupplierBackfillStats> {
  const stats: SupplierBackfillStats = {
    suppliersCreated: 0,
    linksCreated: 0,
    linksKept: 0,
    legacySynced: 0,
  };

  // Every ingredient (active + trashed) that carries a non-blank supplier text.
  const rows = await db
    .select({ id: ingredients.id, supplier: ingredients.supplier })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        isNotNull(ingredients.supplier),
      ),
    );

  // Group by the normalized dedup key → ingredient ids + the raw spellings seen.
  type Group = { ingredientIds: string[]; rawNames: string[] };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const raw = (r.supplier ?? '').trim();
    if (raw === '') continue;
    const key = normalizeSupplierName(raw);
    if (key === '') continue;
    const g = groups.get(key) ?? { ingredientIds: [], rawNames: [] };
    g.ingredientIds.push(r.id);
    g.rawNames.push(raw);
    groups.set(key, g);
  }

  for (const [key, group] of groups) {
    const displayName = pickSupplierDisplayName(group.rawNames);

    // Create the supplier for this key (idempotent), then refetch its id + name.
    const inserted = await db
      .insert(suppliers)
      .values({ organizationId, name: displayName, normalizedName: key })
      .onConflictDoNothing({
        target: [suppliers.organizationId, suppliers.normalizedName],
      })
      .returning({ id: suppliers.id });
    let supplierId: string;
    let supplierName: string;
    if (inserted[0]) {
      stats.suppliersCreated += 1;
      supplierId = inserted[0].id;
      supplierName = displayName;
    } else {
      const [existing] = await db
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(
          and(
            eq(suppliers.organizationId, organizationId),
            eq(suppliers.normalizedName, key),
          ),
        )
        .limit(1);
      if (!existing) continue; // unreachable in practice
      supplierId = existing.id;
      supplierName = existing.name;
    }

    for (const ingredientId of group.ingredientIds) {
      // §12.2 — respect an existing default link; only sync the legacy mirror.
      const existingDefault = await getDefaultLink(db, organizationId, ingredientId);
      if (existingDefault) {
        stats.linksKept += 1;
        await db
          .update(ingredients)
          .set({ supplier: existingDefault.supplier.name })
          .where(
            and(
              eq(ingredients.organizationId, organizationId),
              eq(ingredients.id, ingredientId),
            ),
          );
        stats.legacySynced += 1;
        continue;
      }

      // Else create the default link + set the legacy mirror to the canonical name.
      const link = await db
        .insert(ingredientSuppliers)
        .values({ organizationId, ingredientId, supplierId, isDefault: true })
        .onConflictDoNothing({
          target: [
            ingredientSuppliers.organizationId,
            ingredientSuppliers.ingredientId,
            ingredientSuppliers.supplierId,
          ],
        })
        .returning({ id: ingredientSuppliers.id });
      if (link[0]) stats.linksCreated += 1;
      await db
        .update(ingredients)
        .set({ supplier: supplierName })
        .where(
          and(
            eq(ingredients.organizationId, organizationId),
            eq(ingredients.id, ingredientId),
          ),
        );
      stats.legacySynced += 1;
    }
  }

  return stats;
}
