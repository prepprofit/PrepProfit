import { getTranslations } from 'next-intl/server';
import { ThemedOrganizationList } from '@/components/auth/themed-clerk';

export default async function SelectOrganizationPage() {
  const t = await getTranslations('selectOrg');

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6">
      <div className="text-center">
        <h1 className="font-display text-2xl font-semibold text-foreground">
          {t('title')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <ThemedOrganizationList />
    </div>
  );
}
