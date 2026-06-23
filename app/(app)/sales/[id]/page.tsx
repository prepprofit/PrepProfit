import { notFound } from 'next/navigation';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { canUseFeature } from '@/lib/entitlements';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import {
  getSaleWithItems,
  listSaleIngredientOptions,
  listSaleMenuOptions,
  listSaleRecipeOptions,
} from '@/lib/data/sales';
import { NoAccess } from '@/components/app/no-access';
import { UpgradeRequired } from '@/components/app/upgrade-required';
import { SaleEditor } from '@/components/app/sales/sale-editor';
import { SaleReadonly } from '@/components/app/sales/sale-readonly';

/**
 * Daily-close detail (Sprint 12a). Manager-only + `invoices`-gated. A DRAFT renders the
 * editor (with the catalogue options); a POSTED/VOID close renders the read-only view.
 */
export default async function SaleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;
  if (!(await canUseFeature('invoices'))) return <UpgradeRequired />;

  const { id } = await params;
  const organizationId = await getOrgId();

  const { sale, options } = await withOrg(organizationId, async (tx) => {
    const sale = await getSaleWithItems(tx, organizationId, id);
    if (!sale || sale.status !== 'draft') return { sale, options: null };
    const options = {
      recipes: await listSaleRecipeOptions(tx, organizationId),
      menus: await listSaleMenuOptions(tx, organizationId),
      ingredients: await listSaleIngredientOptions(tx, organizationId),
    };
    return { sale, options };
  });

  if (!sale) notFound();

  const settings = await getOrgSettings();

  if (sale.status !== 'draft' || !options) {
    return <SaleReadonly sale={sale} currency={settings.currency} />;
  }

  return (
    <SaleEditor
      mode="edit"
      saleId={sale.id}
      expectedUpdatedAt={sale.updatedAt}
      initial={{
        saleDate: sale.saleDate,
        note: sale.note,
        lines: sale.lines.map((l) => ({
          itemKind: l.itemKind,
          itemId:
            (l.itemKind === 'recipe'
              ? l.itemRecipeId
              : l.itemKind === 'menu'
                ? l.itemMenuId
                : l.itemIngredientId) ?? '',
          itemName: l.itemName,
          quantity: l.quantity,
          unitNetCents: l.unitNetCents,
          taxRateBps: l.taxRateBps,
          ingredientQtyCanonical: l.ingredientQtyCanonical,
          available: l.available,
        })),
      }}
      options={options}
      defaultTaxRateBps={settings.defaultTaxRateBps}
      currency={settings.currency}
    />
  );
}
