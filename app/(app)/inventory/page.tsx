import { getTranslations } from 'next-intl/server';
import { getOrgId, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listIngredients, toKitchenIngredient } from '@/lib/data/ingredients';
import { getOrgSettings } from '@/lib/data/org-settings';
import {
  ensureDefaultArea,
  listAreas,
} from '@/lib/data/storage-areas';
import { areaBalances, listStockCounts } from '@/lib/data/inventory-areas';
import { InventoryPanel } from '@/components/app/inventory/inventory-panel';
import { InventoryDepth } from '@/components/app/inventory/inventory-depth';

export default async function InventoryPage() {
  const t = await getTranslations('inventory');
  const organizationId = await getOrgId();
  const manager = await isManager();

  const [{ ingredientRows, areas, balancesByArea, counts }, settings] =
    await Promise.all([
      withOrg(organizationId, async (tx) => {
        // Lazy-ensure the immutable default area (the webhook/seed do it eagerly; this
        // is the safety net for a pre-12c org that never hit the webhook).
        await ensureDefaultArea(tx, organizationId);
        const areas = await listAreas(tx, organizationId);
        const [ingredientRows, counts] = await Promise.all([
          listIngredients(tx, organizationId),
          listStockCounts(tx, organizationId),
        ]);
        // Per-area balances (the default area also folds in the legacy NULL bucket).
        const balancesByArea: Record<string, Record<string, number>> = {};
        for (const area of areas) {
          const map = await areaBalances(tx, organizationId, {
            id: area.id,
            isDefault: area.isDefault,
          });
          balancesByArea[area.id] = Object.fromEntries(map);
        }
        return { ingredientRows, areas, balancesByArea, counts };
      }),
      getOrgSettings(),
    ]);

  // Inventory adjust/threshold table is operational (no money to any role).
  const ingredients = ingredientRows.map(toKitchenIngredient);

  // Stock value is MANAGER-ONLY (F4): the price map is omitted entirely for kitchen,
  // so `priceCents` never reaches the client for a non-manager (key-absence projection).
  const priceByIngredient = manager
    ? Object.fromEntries(ingredientRows.map((i) => [i.id, i.priceCents]))
    : null;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>

      <InventoryDepth
        manager={manager}
        currency={settings.currency}
        measurementSystem={settings.measurementSystem}
        areas={areas.map((a) => ({
          id: a.id,
          name: a.name,
          isDefault: a.isDefault,
          updatedAt: a.updatedAt.toISOString(),
        }))}
        ingredients={ingredients.map((i) => ({
          id: i.id,
          name: i.name,
          dimension: i.dimension,
        }))}
        balancesByArea={balancesByArea}
        priceByIngredient={priceByIngredient}
        counts={counts.map((c) => ({
          id: c.id,
          storageAreaId: c.storageAreaId,
          status: c.status,
          committedAt: c.committedAt ? c.committedAt.toISOString() : null,
          updatedAt: c.updatedAt.toISOString(),
        }))}
      />

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">{t('columns.adjust')}</h2>
        <InventoryPanel
          ingredients={ingredients}
          measurementSystem={settings.measurementSystem}
        />
      </div>
    </div>
  );
}
