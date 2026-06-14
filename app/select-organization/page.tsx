import { OrganizationList } from '@clerk/nextjs';
import { getTranslations } from 'next-intl/server';

export default async function SelectOrganizationPage() {
  const t = await getTranslations('selectOrg');

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="font-display text-2xl font-semibold text-slate-900">
          {t('title')}
        </h1>
        <p className="mt-2 text-sm text-slate-500">{t('description')}</p>
      </div>
      <OrganizationList
        hidePersonal
        afterCreateOrganizationUrl="/dashboard"
        afterSelectOrganizationUrl="/dashboard"
      />
    </div>
  );
}
