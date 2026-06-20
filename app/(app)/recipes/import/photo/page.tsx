import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { canUseFeature } from '@/lib/entitlements';
import { getOrgSettings } from '@/lib/data/org-settings';
import { NoAccess } from '@/components/app/no-access';
import { UpgradeRequired } from '@/components/app/upgrade-required';
import { PhotoImportWorkbench } from './photo-workbench';

/**
 * AI photo recipe extraction (Sprint 4.7). Manager-only AND entitlement-gated on
 * the SERVER (defense-in-depth — the upload route enforces the same with 403/402):
 * kitchen users get NoAccess; a plan without `ai_extraction` gets UpgradeRequired.
 * Distinct from `/import` (the deterministic file workbench). The extracted draft
 * is always staged for human review — never an automatic write (CLAUDE.md).
 */
export default async function PhotoImportPage() {
  const t = await getTranslations('recipes.importPhoto');

  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />;
  }
  if (!(await canUseFeature('ai_extraction'))) {
    return <UpgradeRequired body={t('upgrade.body')} />;
  }

  const settings = await getOrgSettings();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <PhotoImportWorkbench measurementSystem={settings.measurementSystem} />
    </div>
  );
}
