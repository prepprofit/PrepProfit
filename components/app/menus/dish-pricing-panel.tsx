'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import type { DishCost, DishResults } from '@/lib/calculations/dish';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InfoPopover } from '@/components/app/recipes/workspace/info-popover';
import { cn } from '@/lib/utils';
import { formatPercentBps, numberToField } from './dish-format';
import { MoneyInput } from './dish-builder-parts';

const DASH = '—';

/**
 * Selling price (excl. VAT primary; incl. VAT + rate secondary), the three results,
 * the optional calculation breakdown and the target ingredient margin calculator.
 * Presentational: every figure arrives computed from `compositionCost` + `dishResults`.
 */
export function DishPricingPanel({
  money,
  currency,
  itemSingular,
  itemPlural,
  items,
  disabled,
  price,
  vat,
  cost,
  results,
  missing,
  target,
}: {
  money: (cents: number) => string;
  currency: string;
  itemSingular: string;
  itemPlural: string;
  items: number | null;
  disabled: boolean;
  price: {
    exclText: string;
    inclText: string;
    exclInvalid: boolean;
    inclInvalid: boolean;
    onChange: (field: 'excl' | 'incl', text: string) => void;
    onBlur: () => void;
  };
  vat: {
    text: string;
    invalid: boolean;
    placeholder: string;
    info: string;
    onChange: (text: string) => void;
  };
  cost: DishCost;
  results: DishResults;
  /** Short reasons why some results are blank; empty when complete. */
  missing: { key: string; text: string; action?: { label: string; onClick: () => void } }[];
  target: {
    text: string;
    onChange: (text: string) => void;
    invalid: boolean;
    targetBps: number | null;
    suggestedExcl: number | null;
    suggestedIncl: number | null;
    canUse: boolean;
    onUse: () => void;
    /** A warning or note about the suggested price vs the total cost, if any. */
    coverNote: { tone: 'warning' | 'muted'; text: string } | null;
  };
}) {
  const t = useTranslations('menus.builder');
  const earnedNegative = results.earnedPerWorkHourCents !== null && results.earnedPerWorkHourCents < 0;
  const remainingNegative = results.remainingCents !== null && results.remainingCents < 0;
  const marginNegative = results.ingredientMarginBps !== null && results.ingredientMarginBps < 0;

  const workHours = cost.workHours;
  const extraHours = cost.extraWorkHours ?? 0;

  return (
    <div className="flex flex-col gap-5">
      {/* ── Selling price ─────────────────────────────────────────────────── */}
      <section aria-labelledby="dish-price-heading" className="flex flex-col gap-3">
        <h2 id="dish-price-heading" className="text-lg font-semibold text-foreground">
          {t('price.heading', { unit: itemSingular })}
        </h2>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-1.5 sm:w-64">
            <Label htmlFor="price-excl" className="text-sm text-muted-foreground">
              {t('price.excl')}
            </Label>
            <MoneyInput
              id="price-excl"
              size="lg"
              value={price.exclText}
              currency={currency}
              invalid={price.exclInvalid}
              disabled={disabled}
              onChange={(v) => price.onChange('excl', v)}
              onBlur={price.onBlur}
            />
          </div>
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="price-incl" className="text-xs font-normal text-muted-foreground">
                {t('price.incl')}
              </Label>
              <MoneyInput
                id="price-incl"
                size="sm"
                className="w-32"
                value={price.inclText}
                currency={currency}
                invalid={price.inclInvalid}
                disabled={disabled}
                onChange={(v) => price.onChange('incl', v)}
                onBlur={price.onBlur}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1">
                <Label htmlFor="vat-rate" className="text-xs font-normal text-muted-foreground">
                  {t('price.vat')}
                </Label>
                <InfoPopover label={t('infoLabel', { topic: t('price.topic') })}>{vat.info}</InfoPopover>
              </span>
              <div className="relative w-24">
                <Input
                  id="vat-rate"
                  inputMode="decimal"
                  value={vat.text}
                  aria-invalid={vat.invalid}
                  placeholder={vat.placeholder}
                  onChange={(e) => vat.onChange(e.target.value)}
                  className="h-11 pr-7 text-right text-base tabular-nums"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <div
          className={cn(
            'flex items-center justify-between gap-3 rounded-2xl px-4 py-4',
            earnedNegative ? 'bg-red-50 dark:bg-red-500/15' : 'bg-primary-soft/60 dark:bg-accent-950/40',
          )}
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground sm:text-base">
            {t('results.earned')}
            <InfoPopover label={t('infoLabel', { topic: t('results.earnedTopic') })}>{t('results.earnedInfo')}</InfoPopover>
          </span>
          <span
            data-testid="earned-per-hour"
            className={cn(
              'font-display text-3xl font-semibold tabular-nums sm:text-4xl',
              earnedNegative ? 'text-red-700 dark:text-red-300' : 'text-primary-soft-foreground dark:text-accent-200',
            )}
          >
            {results.earnedPerWorkHourCents !== null ? money(results.earnedPerWorkHourCents) : DASH}
          </span>
        </div>
        <dl className="flex flex-col gap-2 px-1 text-sm">
          <ResultRow
            label={t('results.totalCost')}
            info={<InfoPopover label={t('infoLabel', { topic: t('results.totalCostTopic') })}>{t('results.totalCostInfo')}</InfoPopover>}
            value={results.totalCostPerItemCents !== null ? money(results.totalCostPerItemCents) : DASH}
          />
          <ResultRow
            label={t('results.ingredientMargin')}
            info={
              <InfoPopover label={t('infoLabel', { topic: t('results.ingredientMarginTopic') })}>
                {t('results.ingredientMarginInfo')}
              </InfoPopover>
            }
            value={results.ingredientMarginBps !== null ? formatPercentBps(results.ingredientMarginBps) : DASH}
            detail={results.foodCostBps !== null ? t('results.foodCost', { percent: formatPercentBps(results.foodCostBps) }) : undefined}
            negative={marginNegative}
          />
        </dl>
        {items !== null && results.priceExclCents !== null && results.priceExclCents > 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            {t('results.assumes', { count: items, label: itemPlural, price: money(results.priceExclCents) })}
          </p>
        ) : null}
        {missing.length > 0 ? (
          <ul className="flex flex-col gap-1.5 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
            {missing.map((m) => (
              <li key={m.key} className="flex flex-wrap items-center gap-2">
                <AlertTriangle className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{m.text}</span>
                {m.action ? (
                  <button
                    type="button"
                    onClick={m.action.onClick}
                    className="min-h-8 rounded-full px-2 font-medium underline underline-offset-2 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:text-amber-100"
                  >
                    {m.action.label}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {/* ── See calculation (quiet) ─────────────────────────────────────── */}
        <Accordion type="single" collapsible>
          <AccordionItem value="calc" className="border-b-0">
            <AccordionTrigger className="py-2 text-sm font-normal text-muted-foreground hover:no-underline">
              {t('calc.toggle')}
            </AccordionTrigger>
            <AccordionContent>
              <dl className="flex flex-col gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm">
                <CalcRow
                  label={t('calc.sales')}
                  detail={
                    items !== null && results.priceExclCents !== null
                      ? t('calc.salesDetail', { count: items, price: money(results.priceExclCents) })
                      : undefined
                  }
                  value={results.salesCents !== null ? money(results.salesCents) : DASH}
                />
                <CalcRow
                  label={t('calc.components')}
                  detail={
                    cost.foodCents !== null && cost.packagingCents !== null
                      ? t('calc.componentsDetail', { food: money(cost.foodCents), packaging: money(cost.packagingCents) })
                      : undefined
                  }
                  value={cost.componentsCents !== null ? money(cost.componentsCents) : t('calc.unknown')}
                  minus
                />
                <CalcRow
                  label={t('calc.labour')}
                  detail={
                    cost.labourHours !== null && cost.labourHourlyCents !== null
                      ? t('calc.labourDetail', { hours: numberToField(cost.labourHours), rate: money(cost.labourHourlyCents) })
                      : undefined
                  }
                  value={
                    !cost.labourEntered
                      ? t('calc.notEntered')
                      : cost.productionLabourCents !== null
                        ? money(cost.productionLabourCents)
                        : t('calc.unknown')
                  }
                  minus
                />
                <CalcRow
                  label={t('calc.extras')}
                  detail={extraHours > 0 ? t('calc.extrasDetail', { hours: numberToField(extraHours) }) : undefined}
                  value={
                    cost.extraWorkCents !== null && cost.expensesCents !== null
                      ? money(cost.extraWorkCents + cost.expensesCents)
                      : t('calc.unknown')
                  }
                  minus
                />
                <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-2 font-semibold">
                  <dt className="text-foreground">{t('calc.remaining')}</dt>
                  <dd className={cn('tabular-nums', remainingNegative ? 'text-red-700 dark:text-red-300' : 'text-foreground')}>
                    {results.remainingCents !== null ? money(results.remainingCents) : DASH}
                  </dd>
                </div>
                <CalcRow
                  label={t('calc.workHours')}
                  value={workHours !== null ? `${numberToField(workHours)} h` : t('calc.notEntered')}
                />
              </dl>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {/* ── Target ingredient margin (pale cyan) ─────────────────────────── */}
      <section
        aria-labelledby="target-margin-heading"
        className="flex flex-col gap-3 rounded-2xl bg-accent-50 p-4 ring-1 ring-accent-200 dark:bg-accent-950/40 dark:ring-accent-800/60 sm:p-5"
      >
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="flex flex-col gap-1.5">
            <Label id="target-margin-heading" htmlFor="target-margin" className="text-sm font-semibold text-foreground">
              {t('target.title')}
            </Label>
            <div className="relative w-28">
              <Input
                id="target-margin"
                inputMode="decimal"
                value={target.text}
                placeholder="70"
                aria-invalid={target.invalid}
                aria-describedby="target-margin-equivalent"
                onChange={(e) => target.onChange(e.target.value)}
                className="h-12 bg-surface pr-8 text-right text-lg tabular-nums"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <p id="target-margin-equivalent" className="pb-3 text-sm text-muted-foreground">
            {target.invalid
              ? t('target.invalid')
              : target.targetBps !== null
                ? t('target.equivalent', {
                    margin: formatPercentBps(target.targetBps),
                    food: formatPercentBps(10_000 - target.targetBps),
                  })
                : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 ring-1 ring-border">
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">{t('target.suggested')}</span>
            <span className="font-display text-2xl font-semibold tabular-nums text-foreground" data-testid="suggested-price">
              {target.suggestedExcl !== null ? money(target.suggestedExcl) : DASH}
            </span>
            {target.suggestedIncl !== null ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {t('target.suggestedIncl', { price: money(target.suggestedIncl) })}
              </span>
            ) : null}
          </div>
          <Button type="button" variant="outline" disabled={!target.canUse} onClick={target.onUse} className="min-h-11">
            {t('target.use')}
          </Button>
        </div>
        {target.coverNote ? (
          <p
            className={cn(
              'flex items-start gap-2 text-sm',
              target.coverNote.tone === 'warning' ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground',
            )}
          >
            {target.coverNote.tone === 'warning' ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> : null}
            {target.coverNote.text}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {target.targetBps !== null && target.suggestedExcl === null ? t('target.needsFood') : t('target.hint')}
        </p>
      </section>
    </div>
  );
}

function ResultRow({
  label,
  info,
  value,
  detail,
  negative,
}: {
  label: string;
  info: React.ReactNode;
  value: string;
  detail?: string;
  negative?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex items-center gap-1.5 whitespace-nowrap font-medium text-foreground">
        {label}
        {info}
      </dt>
      <dd className="flex flex-col-reverse items-end text-right sm:flex-row sm:items-baseline sm:gap-2">
        {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
        <span
          className={cn(
            'font-display text-xl font-semibold tabular-nums',
            negative ? 'text-red-700 dark:text-red-300' : 'text-foreground',
          )}
        >
          {value}
        </span>
      </dd>
    </div>
  );
}

function CalcRow({ label, detail, value, minus }: { label: string; detail?: string; value: string; minus?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex min-w-0 flex-col text-muted-foreground">
        <span>
          {minus ? '− ' : ''}
          {label}
        </span>
        {detail ? <span className="text-xs">{detail}</span> : null}
      </dt>
      <dd className="shrink-0 tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
