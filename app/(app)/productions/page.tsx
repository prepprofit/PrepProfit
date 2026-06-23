import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  listKitchenProductions,
  listManagerProductions,
} from '@/lib/data/productions';
import { getOrgSettings } from '@/lib/data/org-settings';
import {
  ProductionsList,
  type ListProduction,
} from '@/components/app/productions/productions-list';

/**
 * Production list (Sprint 11a). BOTH roles see reference/status/date/count and the
 * incomplete marker; the manager additionally sees the current estimated cost. F4:
 * the kitchen branch loads the money-free loader, so no cost key reaches the client.
 */
export default async function ProductionsPage() {
  const organizationId = await getOrgId();
  const canManage = canSeeRecipeCosts(await getUserRole());

  if (canManage) {
    const [rows, settings] = await Promise.all([
      withOrg(organizationId, (tx) => listManagerProductions(tx, organizationId)),
      getOrgSettings(),
    ]);
    const productions: ListProduction[] = rows.map((p) => ({
      id: p.id,
      reference: p.reference,
      status: p.status,
      plannedFor: p.plannedFor,
      itemCount: p.itemCount,
      complete: p.complete,
      costCents: p.costCents,
    }));
    return (
      <ProductionsList
        productions={productions}
        canManage
        currency={settings.currency}
      />
    );
  }

  const rows = await withOrg(organizationId, (tx) =>
    listKitchenProductions(tx, organizationId),
  );
  const productions: ListProduction[] = rows.map((p) => ({
    id: p.id,
    reference: p.reference,
    status: p.status,
    plannedFor: p.plannedFor,
    itemCount: p.itemCount,
    complete: p.complete,
  }));
  // Kitchen never sees money — currency is unused (no cost column renders).
  return <ProductionsList productions={productions} canManage={false} currency="" />;
}
