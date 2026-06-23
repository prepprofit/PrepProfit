import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { canUseFeature } from '@/lib/entitlements';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import {
  listSaleIngredientOptions,
  listSaleMenuOptions,
  listSaleRecipeOptions,
} from '@/lib/data/sales';
import { NoAccess } from '@/components/app/no-access';
import { UpgradeRequired } from '@/components/app/upgrade-required';
import { SaleEditor } from '@/components/app/sales/sale-editor';

/** New daily-close draft (Sprint 12a). Manager-only + `invoices`-gated. */
export default async function NewSalePage() {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;
  if (!(await canUseFeature('invoices'))) return <UpgradeRequired />;

  const organizationId = await getOrgId();
  const [options, settings] = await Promise.all([
    withOrg(organizationId, async (tx) => ({
      recipes: await listSaleRecipeOptions(tx, organizationId),
      menus: await listSaleMenuOptions(tx, organizationId),
      ingredients: await listSaleIngredientOptions(tx, organizationId),
    })),
    getOrgSettings(),
  ]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <SaleEditor
      mode="create"
      initial={{ saleDate: today, note: null, lines: [] }}
      options={options}
      defaultTaxRateBps={settings.defaultTaxRateBps}
      currency={settings.currency}
    />
  );
}
