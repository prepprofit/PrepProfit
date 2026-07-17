'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const PRESET_FACTORS = [0.5, 1, 2, 3, 4, 6];

/**
 * View-mode batch scaling (plan §7.1): purely client-side and DERIVED — the
 * saved recipe is never touched. The factor multiplies every displayed
 * quantity, the yield and (for managers) the batch cost from the canonical
 * base values.
 */
export function BatchScaleControl({
  factor,
  onFactorChange,
}: {
  factor: number;
  onFactorChange: (factor: number) => void;
}) {
  const t = useTranslations('recipes.workspace');
  const [custom, setCustom] = React.useState('');

  const applyCustom = () => {
    const value = Number(custom.replace(',', '.'));
    if (Number.isFinite(value) && value > 0 && value <= 1000) {
      onFactorChange(value);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('scale')}
      </span>
      {PRESET_FACTORS.map((preset) => (
        <Button
          key={preset}
          type="button"
          size="sm"
          variant={factor === preset ? 'default' : 'outline'}
          onClick={() => onFactorChange(preset)}
        >
          {preset}x
        </Button>
      ))}
      <div className="flex items-center gap-1">
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyCustom();
          }}
          placeholder={t('customFactor')}
          inputMode="decimal"
          className="h-8 w-20"
          aria-label={t('customFactor')}
        />
        <Button type="button" size="sm" variant="outline" onClick={applyCustom}>
          ×
        </Button>
      </div>
      {factor !== 1 ? (
        <span className="rounded-full bg-accent-100 px-2 py-0.5 text-xs font-medium text-accent-800 dark:bg-accent-900/40 dark:text-accent-200">
          {t('scaledBadge', { factor })}
        </span>
      ) : null}
    </div>
  );
}
