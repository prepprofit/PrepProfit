'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { breakEven } from '@/lib/calculations/breakEven';
import { formatMoney } from '@/lib/format/money';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';

const RANGES = {
  fixed: { min: 0, max: 2_000_000, step: 5_000 },
  unit: { min: 0, max: 10_000, step: 25 },
} as const;

/**
 * Live break-even scenario simulator. Sliders feed the pure `breakEven` fn on
 * every move; a non-positive contribution margin shows a graceful "not
 * achievable" state (no NaN/Infinity). All money is integer cents.
 */
export function BreakEvenSimulator({ currency }: { currency: string }) {
  const t = useTranslations('finance.breakEven');
  const [fixedCostsCents, setFixed] = React.useState(500_000);
  const [pricePerUnitCents, setPrice] = React.useState(1_200);
  const [variableCostPerUnitCents, setVariable] = React.useState(400);

  const result = breakEven({
    fixedCostsCents,
    pricePerUnitCents,
    variableCostPerUnitCents,
  });
  const money = (cents: number) => formatMoney(cents, currency);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle>{t('subtitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <SliderRow
            id="be-fixed"
            label={t('fixedCosts')}
            value={fixedCostsCents}
            display={money(fixedCostsCents)}
            range={RANGES.fixed}
            onChange={setFixed}
          />
          <SliderRow
            id="be-price"
            label={t('price')}
            value={pricePerUnitCents}
            display={money(pricePerUnitCents)}
            range={RANGES.unit}
            onChange={setPrice}
          />
          <SliderRow
            id="be-variable"
            label={t('variableCost')}
            value={variableCostPerUnitCents}
            display={money(variableCostPerUnitCents)}
            range={RANGES.unit}
            onChange={setVariable}
          />
        </CardContent>
      </Card>

      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle>{t('unitsLabel')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{t('contribution')}</span>
            <span className="font-medium text-foreground">
              {money(result.contributionPerUnitCents)}
            </span>
          </div>

          {result.achievable ? (
            <>
              <div>
                <p className="font-display text-3xl font-semibold tracking-tight text-foreground">
                  {result.breakEvenUnits}
                </p>
                <p className="text-sm text-muted-foreground">{t('unitsLabel')}</p>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border pt-3 text-sm">
                <span className="text-muted-foreground">{t('revenueLabel')}</span>
                <span className="font-semibold text-foreground">
                  {money(result.breakEvenRevenueCents)}
                </span>
              </div>
            </>
          ) : (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{t('notAchievable')}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SliderRow({
  id,
  label,
  value,
  display,
  range,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  display: string;
  range: { min: number; max: number; step: number };
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-sm font-medium text-foreground">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer"
        style={{ accentColor: 'var(--color-accent-500)' }}
      />
    </div>
  );
}
