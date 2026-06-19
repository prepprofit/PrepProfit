import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { canUseFeature } from '@/lib/entitlements';
import { getOrgSettings } from '@/lib/data/org-settings';
import { NoAccess } from '@/components/app/no-access';
import { UpgradeRequired } from '@/components/app/upgrade-required';
import { BreakEvenSimulator } from '@/components/app/finance/break-even-simulator';

/** Break-even calculator with a live scenario simulator. Manager-only, Pro+ plan. */
export default async function BreakEvenPage() {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;
  if (!(await canUseFeature('break_even'))) return <UpgradeRequired />;

  const t = await getTranslations('finance.breakEven');
  const settings = await getOrgSettings();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <BreakEvenSimulator currency={settings.currency} />
    </div>
  );
}
