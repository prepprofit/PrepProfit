import { and, eq } from 'drizzle-orm';
import { supplierInvoiceImports, supplierInvoiceImportLines } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import {
  projectPendingCostImpact,
  type ProjectedCostImpact,
} from '@/lib/calculations/cost-impact';
import { loadActiveCatalogue } from '@/lib/data/active-catalogue';

/**
 * Invoice-to-Profit Impact loader (Sprint 3, Slice 3.2). Org-scoped (RULE #1);
 * the caller runs it inside `withOrg` so RLS is the second layer. MANAGER-ONLY at
 * the page/action layer (invoice + margin data is financial).
 *
 * The focus set is the distinct ingredients this import actually observed — the
 * `matched_ingredient_id` of its `applied` lines. Everything else (which recipes /
 * menus drop below target if the pending costs are accepted) comes from the tested
 * pure module `projectPendingCostImpact`, which reads the CURRENT approved vs
 * pending state — so as the manager accepts each cost, that ingredient naturally
 * drops out of the impact on the next read.
 *
 * Returns `null` when the import does not exist for this org. A non-applied import
 * (still `draft`, or `void`) has no applied lines, so it yields an empty impact.
 */
export async function loadInvoiceImpact(
  db: TenantClient,
  organizationId: string,
  importId: string,
): Promise<ProjectedCostImpact | null> {
  const [header] = await db
    .select({ id: supplierInvoiceImports.id })
    .from(supplierInvoiceImports)
    .where(
      and(
        eq(supplierInvoiceImports.organizationId, organizationId),
        eq(supplierInvoiceImports.id, importId),
      ),
    )
    .limit(1);
  if (!header) return null;

  const appliedLines = await db
    .select({ matchedIngredientId: supplierInvoiceImportLines.matchedIngredientId })
    .from(supplierInvoiceImportLines)
    .where(
      and(
        eq(supplierInvoiceImportLines.organizationId, organizationId),
        eq(supplierInvoiceImportLines.importId, importId),
        eq(supplierInvoiceImportLines.status, 'applied'),
      ),
    );

  const focusIngredientIds = [
    ...new Set(
      appliedLines
        .map((l) => l.matchedIngredientId)
        .filter((id): id is string => id != null),
    ),
  ];

  const catalogue = await loadActiveCatalogue(db, organizationId);

  return projectPendingCostImpact({
    ingredients: catalogue.ingredients,
    recipes: catalogue.recipes,
    menus: catalogue.menus,
    focusIngredientIds,
  });
}
