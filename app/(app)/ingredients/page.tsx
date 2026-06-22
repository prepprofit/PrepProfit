import { getTranslations } from 'next-intl/server';
import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listIngredients, toKitchenIngredient } from '@/lib/data/ingredients';
import {
  loadIngredientAllergensByIngredient,
  type AllergenTag,
} from '@/lib/data/allergens';
import { listSuppliersWithCounts } from '@/lib/data/suppliers';
import {
  loadDefaultLinksByIngredient,
  type DefaultSupplierSummary,
} from '@/lib/data/ingredient-suppliers';
import { getOrgSettings } from '@/lib/data/org-settings';
import { IngredientGrid } from '@/components/app/ingredients/ingredient-grid';

export default async function IngredientsPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string }>;
}) {
  const t = await getTranslations('ingredients');
  const organizationId = await getOrgId();
  const { highlight } = await searchParams;
  const [ingredientRows, settings, role] = await Promise.all([
    withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
    getOrgSettings(),
    getUserRole(),
  ]);

  // Kitchen sees no price — strip the financial columns from the payload (not just
  // the UI). The grid hides the Price column when `canSeeCosts` is false.
  const canSeeCosts = canSeeRecipeCosts(role);
  const ingredients = canSeeCosts
    ? ingredientRows
    : ingredientRows.map(toKitchenIngredient);

  // Allergens (Sprint 9): batch-load tags for every listed ingredient (no N+1) and
  // derive the reviewed flag from `allergens_reviewed_at`. Operational + money-free,
  // so this is the SAME for kitchen and managers.
  const allergenMap = await withOrg(organizationId, (tx) =>
    loadIngredientAllergensByIngredient(
      tx,
      organizationId,
      ingredientRows.map((r) => r.id),
    ),
  );
  const initialAllergens: Record<string, AllergenTag[]> = {};
  const initialReviewed: Record<string, boolean> = {};
  for (const row of ingredientRows) {
    initialAllergens[row.id] = allergenMap.get(row.id) ?? [];
    initialReviewed[row.id] = row.allergensReviewedAt !== null;
  }

  // Suppliers (Sprint 7) are MANAGER-ONLY: only managers (who see costs) get the
  // active supplier list for the picker + the per-ingredient default link to
  // prefill the editor. Kitchen sees the supplier NAME read-only (it rides on the
  // ingredient row's `supplier` column), but no packs/prices and no editor.
  let supplierNames: string[] = [];
  const initialSupplierLinks: Record<string, DefaultSupplierSummary> = {};
  if (canSeeCosts) {
    const [suppliers, links] = await withOrg(organizationId, async (tx) => [
      await listSuppliersWithCounts(tx, organizationId),
      await loadDefaultLinksByIngredient(
        tx,
        organizationId,
        ingredientRows.map((r) => r.id),
      ),
    ]);
    supplierNames = suppliers.map((s) => s.name);
    for (const [id, link] of links) initialSupplierLinks[id] = link;
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <IngredientGrid
        initialIngredients={ingredients}
        canSeeCosts={canSeeCosts}
        currency={settings.currency}
        highlightId={typeof highlight === 'string' ? highlight : undefined}
        initialAllergens={initialAllergens}
        initialReviewed={initialReviewed}
        supplierNames={supplierNames}
        initialSupplierLinks={initialSupplierLinks}
      />
    </div>
  );
}
