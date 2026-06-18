'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CURRENCIES, MEASUREMENT_SYSTEMS } from '@/lib/validation/org-settings';
import { useActionError } from '@/lib/i18n/use-action-error';
import { updateOrgSettingsAction } from './actions';

export type SettingsFormValues = {
  currency: string;
  measurementSystem: string;
  businessName: string | null;
  businessAddress: string | null;
  businessTaxId: string | null;
  businessEmail: string | null;
  businessLogoUrl: string | null;
};

/**
 * Client form for org-wide settings. Posts to the `useActionState`-shaped Server
 * Action and surfaces its typed `ActionResult` (error via `useActionError`,
 * success via a confirmation), keeping progressive enhancement (native `action`).
 * The stored values are plain strings (the action re-validates them with Zod).
 * One form, two sections: regional (currency/units) + business identity (the
 * seller block printed on invoices, Sprint 3.5A).
 */
export function SettingsForm({ settings }: { settings: SettingsFormValues }) {
  const t = useTranslations('settings');
  const actionError = useActionError();
  const [state, formAction, pending] = useActionState(
    updateOrgSettingsAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('regional.title')}</CardTitle>
          <CardDescription>{t('regional.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="currency">{t('currency.label')}</Label>
            <Select id="currency" name="currency" defaultValue={settings.currency}>
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
            <p className="text-xs text-muted-foreground">{t('measurement.help')}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('business.title')}</CardTitle>
          <CardDescription>{t('business.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="businessName">{t('business.name')}</Label>
            <Input
              id="businessName"
              name="businessName"
              defaultValue={settings.businessName ?? ''}
              placeholder={t('business.namePlaceholder')}
              maxLength={120}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="businessAddress">{t('business.address')}</Label>
            <Textarea
              id="businessAddress"
              name="businessAddress"
              defaultValue={settings.businessAddress ?? ''}
              placeholder={t('business.addressPlaceholder')}
              maxLength={400}
              rows={3}
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="businessTaxId">{t('business.taxId')}</Label>
              <Input
                id="businessTaxId"
                name="businessTaxId"
                defaultValue={settings.businessTaxId ?? ''}
                maxLength={60}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="businessEmail">{t('business.email')}</Label>
              <Input
                id="businessEmail"
                name="businessEmail"
                type="email"
                defaultValue={settings.businessEmail ?? ''}
                maxLength={200}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="businessLogoUrl">{t('business.logoUrl')}</Label>
            <Input
              id="businessLogoUrl"
              name="businessLogoUrl"
              type="url"
              inputMode="url"
              defaultValue={settings.businessLogoUrl ?? ''}
              placeholder="https://"
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">{t('business.logoUrlHelp')}</p>
          </div>
        </CardContent>
      </Card>

      {state && !state.ok && (
        <p className="text-sm text-destructive" role="alert">
          {actionError(state.code)}
        </p>
      )}
      {state?.ok && (
        <p className="text-sm text-emerald-600" role="status">
          {t('saved')}
        </p>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}
