import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  listIngredients,
  listIngredientTypeLocks,
  toKitchenIngredient,
  type IngredientTypeLock,
} from '@/lib/data/ingredients';
import {
  loadIngredientAllergensByIngredient,
  type AllergenTag,
} from '@/lib/data/allergens';
import { listSuppliersWithCounts } from '@/lib/data/suppliers';
import { supplierPickerNames } from '@/lib/suppliers/picker-names';
import {
  loadDefaultLinksByIngredient,
  type DefaultSupplierSummary,
} from '@/lib/data/ingredient-suppliers';
import { getOrgSettings } from '@/lib/data/org-settings';
import { getProfilesForIngredients } from '@/lib/data/ingredient-nutrition';
import { toNutritionView, type IngredientNutritionView } from '@/lib/nutrition/profile-view';
import { listVatCategories, mostCommonPurchaseVatBps } from '@/lib/data/vat-categories';
import {
  IngredientGrid,
  type SupplierPricePrefs,
  type VatCategoryOption,
} from '@/components/app/ingredients/ingredient-grid';

export default async function IngredientsPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string }>;
}) {
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

  // Nutrition is owned by the ingredient: one batch read of every profile. It is
  // operational and money-free — kitchen views it, only managers edit (D5).
  const profileMap = await withOrg(organizationId, (tx) =>
    getProfilesForIngredients(
      tx,
      organizationId,
      ingredientRows.map((r) => r.id),
    ),
  );
  const initialNutrition: Record<string, IngredientNutritionView> = {};
  for (const [id, profile] of profileMap) initialNutrition[id] = toNutritionView(profile);

  // Suppliers (Sprint 7) are MANAGER-ONLY: only managers (who see costs) get the
  // active supplier list for the picker + the per-ingredient default link to
  // prefill the editor. Kitchen sees the supplier NAME read-only (it rides on the
  // ingredient row's `supplier` column), but no packs/prices and no editor.
  let supplierNames: string[] = [];
  // Purchase VAT bands (food 14% vs alcohol 25.5% …). Manager-only, like every
  // other price input: only the incl.↔excl. conversion in the supplier dialog uses
  // them, and kitchen never sees a price at all.
  let vatCategories: VatCategoryOption[] = [];
  const initialSupplierLinks: Record<string, DefaultSupplierSummary> = {};
  // How each supplier quotes prices, remembered from the last time one of their packs
  // was saved, so the dialog's two selects prefill instead of being re-picked.
  const supplierPricePrefs: Record<string, SupplierPricePrefs> = {};
  // The VAT rate prefill's last-resort fallback (§5): the most common CONFIRMED
  // purchase VAT rate among the business's own active ingredients, used only when
  // the business has no configured default. Manager-only, like every other VAT input.
  let mostCommonVatBps: number | null = null;
  if (canSeeCosts) {
    const [suppliers, links, bands, mostCommon] = await withOrg(organizationId, async (tx) => [
      await listSuppliersWithCounts(tx, organizationId),
      await loadDefaultLinksByIngredient(
        tx,
        organizationId,
        ingredientRows.map((r) => r.id),
      ),
      await listVatCategories(tx, organizationId),
      await mostCommonPurchaseVatBps(tx, organizationId),
    ]);
    mostCommonVatBps = mostCommon;
    // Every supplier the business uses is selectable — records AND names already
    // on ingredients (see `supplierPickerNames`).
    supplierNames = supplierPickerNames(
      suppliers.map((s) => s.name),
      ingredientRows.map((r) => r.supplier),
    );
    vatCategories = bands.map((c) => ({
      id: c.id,
      name: c.name,
      rateBps: c.rateBps,
      isDefault: c.isDefault,
    }));
    for (const s of suppliers) {
      supplierPricePrefs[s.name] = {
        basis: s.defaultPriceBasis,
        includesVat: s.defaultPriceIncludesVat,
      };
    }
    for (const [id, link] of links) initialSupplierLinks[id] = link;
  }

  // Type changes are refused while quantities use the current unit; the grid says why.
  const locks = await withOrg(organizationId, (tx) => listIngredientTypeLocks(tx, organizationId));
  const typeLocks: Record<string, IngredientTypeLock> = Object.fromEntries(locks);

  return (
    <div className="flex flex-col gap-5">
      <IngredientGrid
        initialIngredients={ingredients}
        canSeeCosts={canSeeCosts}
        currency={settings.currency}
        highlightId={typeof highlight === 'string' ? highlight : undefined}
        initialAllergens={initialAllergens}
        initialReviewed={initialReviewed}
        supplierNames={supplierNames}
        initialSupplierLinks={initialSupplierLinks}
        supplierPricePrefs={supplierPricePrefs}
        vatCategories={vatCategories}
        businessPurchaseVatBps={settings.defaultPurchaseVatBps ?? null}
        mostCommonPurchaseVatBps={mostCommonVatBps}
        typeLocks={typeLocks}
        initialNutrition={initialNutrition}
        canEditNutrition={role === 'manager'}
      />
    </div>
  );
}
