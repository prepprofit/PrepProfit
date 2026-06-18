'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { CURRENCIES, MEASUREMENT_SYSTEMS } from '@/lib/validation/org-settings';
import { useActionError } from '@/lib/i18n/use-action-error';
import { updateOrgSettingsAction } from './actions';

/**
 * Client form for org-wide settings. Posts to the `useActionState`-shaped Server
 * Action and surfaces its typed `ActionResult` (error via `useActionError`,
 * success via a confirmation), keeping progressive enhancement (native `action`).
 * The stored values are plain strings (the action re-validates them with Zod).
 */
export function SettingsForm({
  settings,
}: {
  settings: { currency: string; measurementSystem: string };
}) {
  const t = useTranslations('settings');
  const actionError = useActionError();
  const [state, formAction, pending] = useActionState(
    updateOrgSettingsAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
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
