import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getOrgSettings } from '@/lib/data/org-settings';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { NoAccess } from '@/components/app/no-access';
import { SettingsForm } from './settings-form';

export default async function SettingsPage() {
  const t = await getTranslations('settings');

  // Org-wide config (currency, measurement system) is a manager concern; kitchen
  // gets NoAccess here AND the action refuses (defense-in-depth).
  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />;
  }

  const settings = await getOrgSettings();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>

      <Card>
        <CardHeader>
          <CardTitle>{t('regional.title')}</CardTitle>
          <CardDescription>{t('regional.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm
            settings={{
              currency: settings.currency,
              measurementSystem: settings.measurementSystem,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
