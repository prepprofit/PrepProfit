import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { listSuppliersWithCounts } from '@/lib/data/suppliers';
import { listIngredients } from '@/lib/data/ingredients';
import {
  listDraftPurchaseOrderDetails,
  listPurchaseOrders,
} from '@/lib/data/purchase-orders';
import { centsToAmountInput } from '@/lib/format/money';
import { NoAccess } from '@/components/app/no-access';
import {
  PurchaseOrdersView,
  type DraftDetail,
} from '@/components/app/purchase-orders/purchase-orders-view';

/**
 * Purchase orders (Sprint 8a, procurement). Manager-only: kitchen gets NoAccess and
 * is blocked in every action. POs are not plan-gated (all plans). Builds the
 * on-screen builder + list; draft line items are loaded so the builder can edit them
 * in place (drafts are few).
 */
export default async function PurchaseOrdersPage() {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const t = await getTranslations('purchaseOrders');
  const organizationId = await getOrgId();

  const [data, settings] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const suppliers = await listSuppliersWithCounts(tx, organizationId, false);
      const ingredients = await listIngredients(tx, organizationId);
      const orders = await listPurchaseOrders(tx, organizationId);
      const draftIds = orders.filter((o) => o.status === 'draft').map((o) => o.id);
      const draftDetails = await listDraftPurchaseOrderDetails(
        tx,
        organizationId,
        draftIds,
      );
      return { suppliers, ingredients, orders, draftDetails };
    }),
    getOrgSettings(),
  ]);

  const drafts: Record<string, DraftDetail> = {};
  for (const detail of data.draftDetails) {
    drafts[detail.order.id] = {
      id: detail.order.id,
      supplierId: detail.order.supplierId ?? '',
      expectedDate: detail.order.expectedDate ?? '',
      notes: detail.order.notes ?? '',
      lines: detail.items.map((it) => ({
        ingredientId: it.ingredientId ?? '',
        quantity: String(Number(it.quantity)),
        unitCost: centsToAmountInput(it.unitCostCents),
      })),
    };
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <PurchaseOrdersView
        currency={settings.currency}
        suppliers={data.suppliers.map((s) => ({ id: s.id, name: s.name }))}
        ingredients={data.ingredients.map((i) => ({
          id: i.id,
          name: i.name,
          dimension: i.dimension,
          priceCents: i.priceCents,
        }))}
        orders={data.orders.map((o) => ({
          id: o.id,
          number: o.number,
          status: o.status,
          supplierName: o.supplierName,
          totalCents: o.totalCents,
          orderDate: o.orderDate,
        }))}
        drafts={drafts}
      />
    </div>
  );
}
