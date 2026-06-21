import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listIngredients, toKitchenIngredient } from '@/lib/data/ingredients';
import { getOrgSettings } from '@/lib/data/org-settings';
import { InventoryPanel } from '@/components/app/inventory/inventory-panel';

export default async function InventoryPage() {
  const t = await getTranslations('inventory');
  const organizationId = await getOrgId();
  const [ingredientRows, settings] = await Promise.all([
    withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
    getOrgSettings(),
  ]);

  // Inventory is operational (stock only) and shows no money to any role — ship the
  // price-free projection so `priceCents` never reaches the client here.
  const ingredients = ingredientRows.map(toKitchenIngredient);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <InventoryPanel
        ingredients={ingredients}
        measurementSystem={settings.measurementSystem}
      />
    </div>
  );
}
