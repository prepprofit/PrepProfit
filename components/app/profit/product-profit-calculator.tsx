'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, ChevronDown, Sparkles, TrendingDown } from 'lucide-react';
import {
  DEFAULT_WASTE_BPS,
  productProfit,
  type HourlyRate,
  type ProductFlag,
} from '@/lib/calculations/profit-hour';
import type { ProfitProduct } from '@/lib/profit/product';
import { SALE_UNITS, type SaleUnit } from '@/lib/validation/profit';
import { formatMoney, parseMoneyToCents } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import { saveProductProfitAction } from '@/app/(app)/profit/actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  centsToField,
  Field,
  parseDecimal,
  useFormatMinutes,
  VERDICT_TEXT,
  VerdictBadge,
} from './profit-shared';

const positiveInt = (input: string): number | null => {
  const value = parseDecimal(input);
  return value !== null && value > 0 ? Math.round(value) : null;
};

/**
 * Per-product Hour Engine calculator (Profit section, Part B). €/hour is the
 * headline, margin % secondary. Core inputs are always visible; packaging, waste,
 * energy, delivery and the extra-step variant sit behind progressive disclosure.
 * Every keystroke recomputes via the pure `productProfit`; Save persists inputs.
 */
export function ProductProfitCalculator({
  product,
  rate,
  currency,
}: {
  product: ProfitProduct;
  rate: HourlyRate | null;
  currency: string;
}) {
  const t = useTranslations('profit.calc');
  const tUnits = useTranslations('profit.units');
  const actionError = useActionError();
  const formatMinutes = useFormatMinutes();
  const money = (cents: number) => formatMoney(cents, currency);

  const [batchTime, setBatchTime] = React.useState(
    product.batchTimeMinutes != null ? String(product.batchTimeMinutes) : '',
  );
  const [batchYield, setBatchYield] = React.useState(String(product.batchYield));
  const [saleUnit, setSaleUnit] = React.useState<SaleUnit>(product.saleUnit ?? 'piece');
  const [price, setPrice] = React.useState(
    product.sellingPriceCents != null ? (product.sellingPriceCents / 100).toFixed(2) : '',
  );
  const [packaging, setPackaging] = React.useState(centsToField(product.packagingPerBatchCents));
  const [waste, setWaste] = React.useState(
    product.wasteBps != null ? String(product.wasteBps / 100) : '',
  );
  const [energy, setEnergy] = React.useState(centsToField(product.energyPerBatchCents));
  const [delivery, setDelivery] = React.useState(centsToField(product.deliveryPerUnitCents));
  const [extraMinutes, setExtraMinutes] = React.useState(
    product.extraStepMinutes != null ? String(product.extraStepMinutes) : '',
  );
  const [extraPrice, setExtraPrice] = React.useState(centsToField(product.extraStepPriceCents));

  const [showMore, setShowMore] = React.useState(
    product.packagingPerBatchCents > 0 ||
      product.energyPerBatchCents > 0 ||
      product.deliveryPerUnitCents > 0 ||
      product.wasteBps != null,
  );
  const [showExtra, setShowExtra] = React.useState(product.extraStepMinutes != null);

  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const batchMinutes = positiveInt(batchTime);
  const yieldUnits = positiveInt(batchYield);
  const priceCents = price.trim() === '' ? null : parseMoneyToCents(price);
  const wastePct = parseDecimal(waste);
  const wasteBps = wastePct === null ? null : Math.round(wastePct * 100);
  const extraMin = positiveInt(extraMinutes);
  const extraPriceCents = extraPrice.trim() !== '' ? parseMoneyToCents(extraPrice) : null;
  const hasExtra = extraMin !== null && extraPriceCents !== null;

  const profit =
    batchMinutes !== null &&
    yieldUnits !== null &&
    priceCents !== null &&
    product.ingredientCostPerBatchCents !== null
      ? productProfit(
          {
            ingredientCostPerBatchCents: product.ingredientCostPerBatchCents,
            packagingPerBatchCents: parseMoneyToCents(packaging),
            energyPerBatchCents: parseMoneyToCents(energy),
            deliveryPerUnitCents: parseMoneyToCents(delivery),
            wasteBps: wasteBps ?? DEFAULT_WASTE_BPS,
            batchMinutes,
            batchYield: yieldUnits,
            sellingPriceCents: priceCents,
            extraStep: hasExtra ? { minutes: extraMin, priceCents: extraPriceCents } : null,
          },
          rate,
        )
      : null;

  const wasteValid = wasteBps === null || (wasteBps >= 0 && wasteBps <= 9_000);
  // A step is both a time and a price, or neither (mirrors the Zod refine).
  const extraValid = hasExtra || (extraMinutes.trim() === '' && extraPrice.trim() === '');
  const canSave =
    batchMinutes !== null && batchMinutes <= 10_080 && yieldUnits !== null && wasteValid && extraValid;

  const touch = <T,>(setter: React.Dispatch<React.SetStateAction<T>>) =>
    (value: T) => {
      setSaved(false);
      setter(value);
    };

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave || batchMinutes === null || yieldUnits === null) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveProductProfitAction(product.id, {
        batchTimeMinutes: batchMinutes,
        batchYield: yieldUnits,
        saleUnit,
        sellingPriceCents: priceCents,
        packagingPerBatchCents: parseMoneyToCents(packaging),
        energyPerBatchCents: parseMoneyToCents(energy),
        deliveryPerUnitCents: parseMoneyToCents(delivery),
        wasteBps,
        extraStepMinutes: hasExtra ? extraMin : null,
        extraStepPriceCents: hasExtra ? extraPriceCents : null,
      });
      if (result.ok) setSaved(true);
      else setError(actionError(result.code));
    });
  }

  const verdict = profit?.verdict ?? 'incomplete';
  const unitLabel = tUnits(saleUnit);

  const flagText = (flag: ProductFlag) =>
    flag === 'belowFloor'
      ? t('flags.belowFloor', { amount: rate ? money(rate.trueHourlyRateCents) : '' })
      : t(`flags.${flag}`);

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
          {product.name}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('coreTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="calc-time" label={t('batchTime')} hint={t('batchTimeHint')}>
                <Input
                  id="calc-time"
                  inputMode="numeric"
                  placeholder="90"
                  value={batchTime}
                  onChange={(e) => touch(setBatchTime)(e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field id="calc-yield" label={t('batchYield')}>
                  <Input
                    id="calc-yield"
                    inputMode="numeric"
                    value={batchYield}
                    onChange={(e) => touch(setBatchYield)(e.target.value)}
                  />
                </Field>
                <Field id="calc-unit" label={t('saleUnit')}>
                  <Select
                    id="calc-unit"
                    value={saleUnit}
                    onChange={(e) => touch(setSaleUnit)(e.target.value as SaleUnit)}
                  >
                    {SALE_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {tUnits(unit)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field id="calc-price" label={t('sellingPrice', { unit: unitLabel })}>
                <Input
                  id="calc-price"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => touch(setPrice)(e.target.value)}
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">
                  {t('ingredientCost', { unit: unitLabel })}
                </span>
                {product.ingredientCostPerBatchCents !== null && yieldUnits !== null ? (
                  <span className="flex h-10 items-center text-sm tabular-nums">
                    {money(Math.round(product.ingredientCostPerBatchCents / yieldUnits))}
                  </span>
                ) : (
                  <span className="text-sm text-amber-700 dark:text-amber-300">
                    {t('ingredientCostUnknown')}
                  </span>
                )}
                <Link
                  href={`/recipes/${product.id}`}
                  className="w-fit text-xs font-medium text-accent-700 hover:underline dark:text-accent-300"
                >
                  {t('editRecipe')}
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card>
            <button
              type="button"
              onClick={() => setShowMore((open) => !open)}
              aria-expanded={showMore}
              className="flex w-full cursor-pointer items-center justify-between gap-2 p-6 text-left"
            >
              <span className="flex flex-col gap-1">
                <span className="font-display text-base font-semibold">{t('moreCosts')}</span>
                <span className="text-sm text-muted-foreground">{t('moreCostsHint')}</span>
              </span>
              <ChevronDown className={cn('size-4 shrink-0 transition-transform', !showMore && '-rotate-90')} />
            </button>
            {showMore && (
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field id="calc-packaging" label={t('packaging')}>
                  <Input
                    id="calc-packaging"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={packaging}
                    onChange={(e) => touch(setPackaging)(e.target.value)}
                  />
                </Field>
                <Field id="calc-waste" label={t('waste')} hint={t('wasteHint')}>
                  <Input
                    id="calc-waste"
                    inputMode="decimal"
                    placeholder={String(DEFAULT_WASTE_BPS / 100)}
                    value={waste}
                    aria-invalid={!wasteValid}
                    onChange={(e) => touch(setWaste)(e.target.value)}
                  />
                </Field>
                <Field id="calc-energy" label={t('energy')}>
                  <Input
                    id="calc-energy"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={energy}
                    onChange={(e) => touch(setEnergy)(e.target.value)}
                  />
                </Field>
                <Field id="calc-delivery" label={t('delivery', { unit: unitLabel })}>
                  <Input
                    id="calc-delivery"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={delivery}
                    onChange={(e) => touch(setDelivery)(e.target.value)}
                  />
                </Field>
              </CardContent>
            )}
          </Card>

          <Card>
            <button
              type="button"
              onClick={() => setShowExtra((open) => !open)}
              aria-expanded={showExtra}
              className="flex w-full cursor-pointer items-center justify-between gap-2 p-6 text-left"
            >
              <span className="flex flex-col gap-1">
                <span className="font-display text-base font-semibold">{t('extraStep')}</span>
                <span className="text-sm text-muted-foreground">{t('extraStepHint')}</span>
              </span>
              <ChevronDown className={cn('size-4 shrink-0 transition-transform', !showExtra && '-rotate-90')} />
            </button>
            {showExtra && (
              <CardContent className="flex flex-col gap-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field id="calc-extra-time" label={t('extraStepTime', { unit: unitLabel })}>
                    <Input
                      id="calc-extra-time"
                      inputMode="numeric"
                      value={extraMinutes}
                      aria-invalid={!extraValid}
                      onChange={(e) => touch(setExtraMinutes)(e.target.value)}
                    />
                  </Field>
                  <Field id="calc-extra-price" label={t('extraStepPrice', { unit: unitLabel })}>
                    <Input
                      id="calc-extra-price"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={extraPrice}
                      aria-invalid={!extraValid}
                      onChange={(e) => touch(setExtraPrice)(e.target.value)}
                    />
                  </Field>
                </div>
                {!extraValid && (
                  <p className="text-sm text-amber-700 dark:text-amber-300">{t('extraStepBoth')}</p>
                )}
                {profit?.extraStepRateCents != null && (
                  <div
                    className={cn(
                      'rounded-lg p-3 text-sm',
                      profit.extraStepBelowRate
                        ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                        : 'bg-surface-2 text-foreground',
                    )}
                  >
                    <p className="font-medium">
                      {t('extraStepRate', { amount: money(profit.extraStepRateCents) })}
                    </p>
                    {profit.extraStepBelowRate && rate && (
                      <p>{t('extraStepBelow', { amount: money(rate.trueHourlyRateCents) })}</p>
                    )}
                  </div>
                )}
              </CardContent>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-6">
              {profit ? (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-muted-foreground">
                      {t('euroPerHour')}
                    </span>
                    {profit.verdict && <VerdictBadge verdict={profit.verdict} />}
                  </div>
                  <p
                    className={cn(
                      'font-display text-4xl font-semibold tabular-nums tracking-tight',
                      VERDICT_TEXT[verdict],
                    )}
                  >
                    {t('perHour', { amount: money(profit.euroPerHourCents) })}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t('marginSecondary')}{' '}
                    <span className="font-medium text-foreground tabular-nums">
                      {profit.marginBps !== null ? `${(profit.marginBps / 100).toFixed(1)}%` : '—'}
                    </span>
                  </p>

                  {profit.flags.length > 0 && (
                    <ul className="flex flex-col gap-2">
                      {profit.flags.map((flag) => (
                        <li
                          key={flag}
                          className={cn(
                            'flex items-start gap-2 rounded-lg p-3 text-sm',
                            flag === 'belowFloor' &&
                              'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
                            flag === 'highMarginLowHour' &&
                              'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
                            flag === 'lowMarginStrong' &&
                              'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
                          )}
                        >
                          {flag === 'belowFloor' ? (
                            <TrendingDown className="mt-0.5 size-4 shrink-0" />
                          ) : flag === 'highMarginLowHour' ? (
                            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                          ) : (
                            <Sparkles className="mt-0.5 size-4 shrink-0" />
                          )}
                          {flagText(flag)}
                        </li>
                      ))}
                    </ul>
                  )}

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 text-sm">
                    <Stat
                      label={t('floorPrice')}
                      value={profit.floorPriceCents !== null ? money(profit.floorPriceCents) : '—'}
                    />
                    <Stat
                      label={t('discountRoom')}
                      value={profit.discountRoomCents !== null ? money(profit.discountRoomCents) : '—'}
                      tone={
                        profit.discountRoomCents !== null && profit.discountRoomCents < 0
                          ? 'negative'
                          : undefined
                      }
                    />
                    <Stat label={t('variableCost')} value={money(profit.variableCostPerUnitCents)} />
                    <Stat label={t('timePerUnit')} value={formatMinutes(profit.minutesPerUnit)} />
                    <Stat
                      label={t('unitsPerHour')}
                      value={(Math.round(profit.unitsPerHour * 10) / 10).toString()}
                    />
                  </dl>
                  {!rate && (
                    <p className="text-sm text-muted-foreground">
                      {t('noRate')}{' '}
                      <Link
                        href="/profit/rate"
                        className="font-medium text-accent-700 hover:underline dark:text-accent-300"
                      >
                        {t('setRate')}
                      </Link>
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('incomplete')}</p>
              )}

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
              <Button type="submit" disabled={!canSave || pending}>
                {pending ? t('saving') : t('save')}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </form>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'negative';
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'font-medium tabular-nums',
          tone === 'negative' ? 'text-red-700 dark:text-red-300' : 'text-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
