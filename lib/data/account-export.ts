import { eq } from 'drizzle-orm';
import type { TenantClient } from '@/lib/db/tenant';
import {
  organizationSettings,
  ingredients,
  recipeFolders,
  recipes,
  recipeIngredients,
  ingredientAllergens,
  recipeAllergenOverrides,
  inventoryMovements,
  ingredientPriceHistory,
  suppliers,
  ingredientSuppliers,
  transactionCategories,
  transactions,
  customers,
  invoiceCounters,
  poCounters,
  invoices,
  invoiceItems,
  purchaseOrders,
  purchaseOrderItems,
  emailOutbox,
  receipts,
  receiptItems,
  employees,
  shifts,
  auditLog,
  subscriptions,
  importJobs,
  aiExtractionAttempts,
} from '@/lib/db/schema';

/**
 * GDPR org data export (Sprint 5e). Builds a single JSON bundle of EVERY business
 * table the org owns, for a portability/access request. RULE #1: must run inside
 * `withOrg(orgId)` so RLS scopes every read to the active tenant; we ALSO filter
 * each query by `organization_id` explicitly (belt-and-suspenders, and so the pure
 * builder is correct even in a non-RLS test harness).
 *
 * Scope: the same tables listed in `businessTables` (lib/db/schema.ts) EXCEPT
 * `rate_limits`, which is infra, not tenant data, carries no `organization_id`, and
 * is absent from `businessTables`. The `audit_log` IS included — it is the org's own
 * activity trail. This is a read-only snapshot; it deletes nothing.
 */

/** Bump when the bundle's shape changes, so importers can detect the version. */
// v2 (Sprint F2): added `ingredientPriceHistory`.
// v3 (Sprint F5): `organizationSettings` gained default_tax_rate_bps +
// stock_control_start_date; `transactions` gained source_type + source_id.
// v4 (Sprint F6): added `poCounters`.
// v5 (Sprint 9): added `ingredientAllergens` + `recipeAllergenOverrides`; the
// `ingredients` rows now carry allergens_reviewed_at/_by (flow through `select()`).
// v6 (Sprint 7): added `suppliers` + `ingredientSuppliers`; `ingredientPriceHistory`
// rows now carry `ingredient_supplier_id` (flows through `select()`).
// v7 (Sprint 8a): added `purchaseOrders` + `purchaseOrderItems` + `emailOutbox`.
// v8 (Sprint 8b): added `receipts` + `receiptItems`; `ingredientPriceHistory` rows
// now carry `source_receipt_item_id` (flows through `select()`).
export const ACCOUNT_EXPORT_SCHEMA_VERSION = 8;

export type OrgDataExport = {
  schemaVersion: number;
  organizationId: string;
  exportedAt: string;
  data: Record<string, unknown[]>;
};

export async function buildOrgDataExport(
  tx: TenantClient,
  organizationId: string,
): Promise<OrgDataExport> {
  // One ordered list keeps the output stable and the org filter uniform. Every
  // business table exposes `.organizationId` (RULE #1).
  const tables = [
    ['organizationSettings', organizationSettings],
    ['ingredients', ingredients],
    ['recipeFolders', recipeFolders],
    ['recipes', recipes],
    ['recipeIngredients', recipeIngredients],
    ['ingredientAllergens', ingredientAllergens],
    ['recipeAllergenOverrides', recipeAllergenOverrides],
    ['inventoryMovements', inventoryMovements],
    ['ingredientPriceHistory', ingredientPriceHistory],
    ['suppliers', suppliers],
    ['ingredientSuppliers', ingredientSuppliers],
    ['transactionCategories', transactionCategories],
    ['transactions', transactions],
    ['customers', customers],
    ['invoiceCounters', invoiceCounters],
    ['poCounters', poCounters],
    ['invoices', invoices],
    ['invoiceItems', invoiceItems],
    ['purchaseOrders', purchaseOrders],
    ['purchaseOrderItems', purchaseOrderItems],
    ['emailOutbox', emailOutbox],
    ['receipts', receipts],
    ['receiptItems', receiptItems],
    ['employees', employees],
    ['shifts', shifts],
    ['auditLog', auditLog],
    ['subscriptions', subscriptions],
    ['importJobs', importJobs],
    ['aiExtractionAttempts', aiExtractionAttempts],
  ] as const;

  const data: Record<string, unknown[]> = {};
  for (const [key, table] of tables) {
    data[key] = await tx
      .select()
      .from(table)
      .where(eq(table.organizationId, organizationId));
  }

  return {
    schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
    organizationId,
    exportedAt: new Date().toISOString(),
    data,
  };
}

/** Total row count across every table — a cheap, PII-free descriptor for the audit log. */
export function countExportRows(bundle: OrgDataExport): number {
  return Object.values(bundle.data).reduce((sum, rows) => sum + rows.length, 0);
}
