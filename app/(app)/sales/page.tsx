import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { canUseFeature } from '@/lib/entitlements';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { listSales } from '@/lib/data/sales';
import { NoAccess } from '@/components/app/no-access';
import { UpgradeRequired } from '@/components/app/upgrade-required';
import { SalesList } from '@/components/app/sales/sales-list';

/**
 * Daily-close Sales list (Sprint 12a). Manager-only (kitchen gets NoAccess here AND
 * is blocked in every action) and gated by the `invoices` plan feature (D4). Shows the
 * org's closes (date, status, line count, frozen gross) + a New-close button + the
 * accepted-v1 double-count warning banner.
 */
export default async function SalesPage() {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;
  if (!(await canUseFeature('invoices'))) return <UpgradeRequired />;

  const organizationId = await getOrgId();
  const [sales, settings] = await Promise.all([
    withOrg(organizationId, (tx) => listSales(tx, organizationId)),
    getOrgSettings(),
  ]);

  return <SalesList sales={sales} currency={settings.currency} />;
}
