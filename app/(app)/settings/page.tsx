import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import {
  getOrgSettingsRow,
  readAccountDeletionState,
  DEFAULT_ORG_SETTINGS,
} from '@/lib/data/org-settings';
import { withOrg } from '@/lib/db';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { bpsToPercent } from '@/lib/calculations/tax';
import { NoAccess } from '@/components/app/no-access';
import { listVatCategories } from '@/lib/data/vat-categories';
import { SettingsForm } from './settings-form';
import { VatCategoriesSection } from './vat-categories-section';
import { AccountPrivacy } from './account-privacy';

export default async function SettingsPage() {
  const t = await getTranslations('settings');

  // Org-wide config (currency, measurement system) is a manager concern; kitchen
  // gets NoAccess here AND the action refuses (defense-in-depth).
  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />;
  }

  // One read for the form values, the pending-deletion state and the VAT bands.
  const organizationId = await getOrgId();
  const [row, vatCategories] = await withOrg(organizationId, async (tx) => [
    await getOrgSettingsRow(tx, organizationId),
    await listVatCategories(tx, organizationId),
  ]);
  const settings = row ?? DEFAULT_ORG_SETTINGS;
  const deletion = readAccountDeletionState(row);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>

      <SettingsForm
        settings={{
          currency: settings.currency,
          measurementSystem: settings.measurementSystem,
          businessName: settings.businessName,
          businessAddress: settings.businessAddress,
          businessTaxId: settings.businessTaxId,
          businessEmail: settings.businessEmail,
          businessLogoUrl: settings.businessLogoUrl,
          defaultTaxRatePercent:
            settings.defaultTaxRateBps == null
              ? null
              : String(bpsToPercent(settings.defaultTaxRateBps)),
          stockControlStartDate: settings.stockControlStartDate,
          weeklyCfoReportEmailEnabled: settings.weeklyCfoReportEmailEnabled,
        }}
      />

      <VatCategoriesSection
        categories={vatCategories.map((c) => ({
          id: c.id,
          name: c.name,
          rateBps: c.rateBps,
          isDefault: c.isDefault,
        }))}
      />

      <AccountPrivacy
        deletionRequestedAt={deletion.requestedAt?.toISOString() ?? null}
      />
    </div>
  );
}
