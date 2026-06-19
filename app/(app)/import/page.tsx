import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { getOrgSettings } from '@/lib/data/org-settings';
import { NoAccess } from '@/components/app/no-access';
import { ImportWorkbench } from './import-workbench';

/**
 * Deterministic import (Sprint 4.5). Manager-only on the SERVER: kitchen-role
 * users get NoAccess here AND every action refuses (defense-in-depth). The page
 * passes the org currency so the preview grid formats money locally.
 */
export default async function ImportPage() {
  const t = await getTranslations('import');

  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />;
  }

  const settings = await getOrgSettings();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <ImportWorkbench currency={settings.currency} />
    </div>
  );
}
