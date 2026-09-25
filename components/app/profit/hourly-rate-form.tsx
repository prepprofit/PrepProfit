'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Calculator } from 'lucide-react';
import {
  DEFAULT_SUBLET_MULTIPLIER_BPS,
  FIXED_COST_KEYS,
  monthlyDepreciationCents,
  trueHourlyRate,
  type FixedCostKey,
  type HourlyRateInput,
} from '@/lib/calculations/profit-hour';
import { centsToAmountInput, formatMoney, parseMoneyToCents } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import { saveProfitSettingsAction } from '@/app/(app)/profit/actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { centsToField, Field, parseDecimal } from './profit-shared';

/**
 * True Hourly Rate setup (Profit section, Part A). Itemised monthly fixed costs,
 * productive hours and the owner's target income feed the pure `trueHourlyRate`
 * live on every keystroke; saving stores the inputs (never the derived rate) so
 * the whole catalogue recalculates on its next read.
 */
export function HourlyRateForm({
  initial,
  currency,
}: {
  initial: HourlyRateInput | null;
  currency: string;
}) {
  const t = useTranslations('profit.rate');
  const actionError = useActionError();
  const money = (cents: number) => formatMoney(cents, currency);

  const [costs, setCosts] = React.useState<Record<FixedCostKey, string>>(() => {
    const out = {} as Record<FixedCostKey, string>;
    for (const key of FIXED_COST_KEYS) out[key] = centsToField(initial?.fixedCostsCents[key]);
    return out;
  });
  const [hours, setHours] = React.useState(
    initial ? String(initial.productiveHoursPerMonth) : '',
  );
  const [owner, setOwner] = React.useState(centsToField(initial?.ownerTargetIncomePerHourCents));
  const [sublet, setSublet] = React.useState(initial?.subletEnabled ?? false);
  const [multiplier, setMultiplier] = React.useState(
    String((initial?.subletIngredientMultiplierBps ?? DEFAULT_SUBLET_MULTIPLIER_BPS) / 10_000),
  );

  const [depOpen, setDepOpen] = React.useState(false);
  const [depPrice, setDepPrice] = React.useState('');
  const [depYears, setDepYears] = React.useState('');

  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const costsCents = React.useMemo(() => {
    const out = {} as Record<FixedCostKey, number>;
    for (const key of FIXED_COST_KEYS) out[key] = parseMoneyToCents(costs[key]);
    return out;
  }, [costs]);
  const hoursValue = parseDecimal(hours);
  const hoursInt = hoursValue === null ? null : Math.round(hoursValue);
  const multiplierValue = parseDecimal(multiplier);
  const multiplierBps =
    multiplierValue === null ? DEFAULT_SUBLET_MULTIPLIER_BPS : Math.round(multiplierValue * 10_000);

  const rate =
    hoursInt !== null && hoursInt > 0
      ? trueHourlyRate({
          fixedCostsCents: costsCents,
          productiveHoursPerMonth: hoursInt,
          ownerTargetIncomePerHourCents: parseMoneyToCents(owner),
          subletEnabled: sublet,
          subletIngredientMultiplierBps: multiplierBps,
        })
      : null;

  const depCents = monthlyDepreciationCents(
    parseMoneyToCents(depPrice),
    parseDecimal(depYears) ?? 0,
  );

  const canSave =
    hoursInt !== null &&
    hoursInt >= 1 &&
    hoursInt <= 744 &&
    (!sublet || (multiplierBps >= 10_000 && multiplierBps <= 30_000));

  function update(key: FixedCostKey, value: string) {
    setSaved(false);
    setCosts((prev) => ({ ...prev, [key]: value }));
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave || hoursInt === null) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveProfitSettingsAction({
        rentCents: costsCents.rent,
        equipmentLeasesCents: costsCents.equipmentLeases,
        equipmentDepreciationCents: costsCents.equipmentDepreciation,
        insuranceLicensesCents: costsCents.insuranceLicenses,
        utilitiesCents: costsCents.utilities,
        salariedStaffCents: costsCents.salariedStaff,
        softwareCents: costsCents.software,
        productiveHoursPerMonth: hoursInt,
        ownerTargetIncomePerHourCents: parseMoneyToCents(owner),
        subletEnabled: sublet,
        subletIngredientMultiplierBps: sublet
          ? multiplierBps
          : (initial?.subletIngredientMultiplierBps ?? DEFAULT_SUBLET_MULTIPLIER_BPS),
      });
      if (result.ok) setSaved(true);
      else setError(actionError(result.code));
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href="/profit"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t('back')}
        </Link>
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('pageSubtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('fixedCostsTitle')}</CardTitle>
              <CardDescription>{t('fixedCostsHint')}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {FIXED_COST_KEYS.map((key) => {
                const disabled = key === 'rent' && sublet;
                return (
                  <Field
                    key={key}
                    id={`rate-${key}`}
                    label={t(`costs.${key}`)}
                    hint={disabled ? t('rentSublet') : undefined}
                  >
                    <Input
                      id={`rate-${key}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={costs[key]}
                      disabled={disabled}
                      onChange={(e) => update(key, e.target.value)}
                    />
                    {key === 'equipmentDepreciation' && (
                      <div className="flex flex-col gap-2">
                        <button
                          type="button"
                          onClick={() => setDepOpen((open) => !open)}
                          aria-expanded={depOpen}
                          className="inline-flex w-fit cursor-pointer items-center gap-1 text-xs font-medium text-accent-700 hover:underline dark:text-accent-300"
                        >
                          <Calculator className="size-3.5" />
                          {t('depreciationHelper')}
                        </button>
                        {depOpen && (
                          <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3">
                            <div className="grid grid-cols-2 gap-2">
                              <Field id="dep-price" label={t('depreciationPrice')}>
                                <Input
                                  id="dep-price"
                                  inputMode="decimal"
                                  className="bg-surface"
                                  value={depPrice}
                                  onChange={(e) => setDepPrice(e.target.value)}
                                />
                              </Field>
                              <Field id="dep-years" label={t('depreciationYears')}>
                                <Input
                                  id="dep-years"
                                  inputMode="decimal"
                                  className="bg-surface"
                                  value={depYears}
                                  onChange={(e) => setDepYears(e.target.value)}
                                />
                              </Field>
                            </div>
                            <p className="text-xs text-muted-foreground">{t('depreciationFormula')}</p>
                            {depCents !== null && depCents > 0 && (
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium tabular-nums">
                                  {t('depreciationResult', { amount: money(depCents) })}
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    update('equipmentDepreciation', centsToAmountInput(depCents));
                                    setDepOpen(false);
                                  }}
                                >
                                  {t('depreciationApply')}
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </Field>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('hoursTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="rate-hours" label={t('hoursLabel')} hint={t('hoursHint')}>
                <Input
                  id="rate-hours"
                  inputMode="numeric"
                  placeholder="120"
                  value={hours}
                  onChange={(e) => {
                    setSaved(false);
                    setHours(e.target.value);
                  }}
                />
              </Field>
              <Field id="rate-owner" label={t('ownerLabel')} hint={t('ownerHint')}>
                <Input
                  id="rate-owner"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={owner}
                  onChange={(e) => {
                    setSaved(false);
                    setOwner(e.target.value);
                  }}
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-4 pt-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <label htmlFor="rate-sublet" className="text-sm font-medium text-foreground">
                    {t('subletTitle')}
                  </label>
                  <p className="text-xs text-muted-foreground">{t('subletHint')}</p>
                </div>
                <Switch
                  id="rate-sublet"
                  checked={sublet}
                  onCheckedChange={(checked) => {
                    setSaved(false);
                    setSublet(checked);
                  }}
                />
              </div>
              {sublet && (
                <Field
                  id="rate-multiplier"
                  label={t('subletMultiplier')}
                  hint={t('subletMultiplierHint')}
                >
                  <Input
                    id="rate-multiplier"
                    inputMode="decimal"
                    className="sm:max-w-40"
                    value={multiplier}
                    onChange={(e) => {
                      setSaved(false);
                      setMultiplier(e.target.value);
                    }}
                  />
                </Field>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <Card className="border-transparent bg-gradient-to-br from-accent-100 to-accent-300 text-primary-soft-foreground shadow-lg shadow-accent-500/20">
            <CardContent className="flex flex-col gap-2 pt-6">
              <span className="text-sm font-medium text-primary-soft-foreground/80">{t('trueRate')}</span>
              {rate ? (
                <>
                  <p className="font-display text-2xl font-semibold leading-tight">
                    {t('headline', { amount: money(rate.trueHourlyRateCents) })}
                  </p>
                  <p className="text-sm text-primary-soft-foreground/80">
                    {t('breakdown', {
                      fixed: money(rate.fixedCostPerHourCents),
                      owner: money(rate.ownerTargetIncomePerHourCents),
                    })}
                  </p>
                </>
              ) : (
                <p className="text-sm text-primary-soft-foreground/80">{t('needsHours')}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-2 pt-6 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('totalFixed')}</span>
                <span className="font-medium tabular-nums">
                  {money(rate?.totalMonthlyFixedCostsCents ?? 0)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('fixedPerHour')}</span>
                <span className="font-medium tabular-nums">
                  {rate ? money(rate.fixedCostPerHourCents) : '—'}
                </span>
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                  {error}
                </p>
              )}
              {saved && (
                <p role="status" className="text-sm text-brand-700 dark:text-brand-300">
                  {t('saved')}
                </p>
              )}
              <Button type="submit" className="mt-2" disabled={!canSave || pending}>
                {pending ? t('saving') : t('save')}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </form>
  );
}
