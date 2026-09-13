import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { getProfitSettingsRow, toHourlyRateInput } from '@/lib/data/profit';
import { NoAccess } from '@/components/app/no-access';
import { HourlyRateForm } from '@/components/app/profit/hourly-rate-form';

/** True Hourly Rate setup (Profit section, Part A). Manager-only. */
export default async function ProfitRatePage() {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const organizationId = await getOrgId();
  const [settings, row] = await Promise.all([
    getOrgSettings(),
    withOrg(organizationId, (tx) => getProfitSettingsRow(tx, organizationId)),
  ]);

  return <HourlyRateForm initial={toHourlyRateInput(row)} currency={settings.currency} />;
}
