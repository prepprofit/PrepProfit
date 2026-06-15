import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { getOrgSettings } from '@/lib/data/org-settings';
import { CURRENCIES, MEASUREMENT_SYSTEMS } from '@/lib/validation/org-settings';
import { updateOrgSettingsAction } from './actions';

export default async function SettingsPage() {
  const t = await getTranslations('settings');
  const settings = await getOrgSettings();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        {t('title')}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('regional.title')}</CardTitle>
          <CardDescription>{t('regional.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateOrgSettingsAction} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="currency">{t('currency.label')}</Label>
              <Select
                id="currency"
                name="currency"
                defaultValue={settings.currency}
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">{t('currency.help')}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="measurementSystem">{t('measurement.label')}</Label>
              <Select
                id="measurementSystem"
                name="measurementSystem"
                defaultValue={settings.measurementSystem}
              >
                {MEASUREMENT_SYSTEMS.map((system) => (
                  <option key={system} value={system}>
                    {t(`measurement.options.${system}`)}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('measurement.help')}
              </p>
            </div>

            <div>
              <Button type="submit">{t('save')}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
