'use client';

import * as React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InfoPopover } from '@/components/app/recipes/workspace/info-popover';
import {
  formatWeightForUnit,
  gramsToDisplayNumber,
  parseWeightInput,
  type WeightDisplayUnit,
} from '@/lib/format/weight';
import type { WeightSummary } from '@/lib/recipes/editor-model';
import { cn } from '@/lib/utils';

export type YieldDraft = {
  mode: 'percent' | 'measured';
  percentText: string;
  /** Measured finished weight in canonical grams, as text ('' = none). */
  measuredText: string;
};

/** "2,150 g" / "2.15 kg" — locale-grouped, no trailing zeros. */
export function useWeightLabel() {
  const format = useFormatter();
  return React.useCallback(
    (grams: number, unit: WeightDisplayUnit) =>
      `${format.number(gramsToDisplayNumber(grams, unit), { maximumFractionDigits: unit === 'kg' ? 4 : 2 })} ${unit}`,
    [format],
  );
}

/**
 * The honest one-line weight summary under the ingredients. An empty recipe says so
 * plainly; ml/piece lines are NAMED (and the subtotal labelled as such) instead of
 * being passed off as the whole batch. Shared by the editor and the recipe page.
 */
export function WeightSummaryLine({
  summary,
  displayUnit,
  children,
}: {
  summary: WeightSummary;
  displayUnit: WeightDisplayUnit;
  /** Trailing action (e.g. "Adjust finished weight"). */
  children?: React.ReactNode;
}) {
  const t = useTranslations('recipes.editor.weight');
  const weight = useWeightLabel();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className={cn('font-medium', summary.state === 'empty' ? 'text-muted-foreground' : 'text-foreground')}>
            {summary.state === 'empty'
              ? t('empty')
              : summary.state === 'complete'
                ? t('total', { weight: weight(summary.totalGrams, displayUnit) })
                : t('partial', { weight: weight(summary.weighedGrams, displayUnit) })}
          </span>
          <InfoPopover label={t('infoLabel')}>{t('info')}</InfoPopover>
        </div>
        {children}
      </div>
      {summary.state === 'partial' ? (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {t('unweighed', { count: summary.unweighed.length, names: summary.unweighed.join(', ') })}
        </p>
      ) : null}
      {summary.state !== 'empty' && summary.missingQuantity.length > 0 ? (
        <p className="text-xs text-muted-foreground">{t('missingQuantity', { count: summary.missingQuantity.length })}</p>
      ) : null}
    </div>
  );
}

/**
 * Weight summary + the existing finished-weight / yield controls, opened only on
 * request. Finished weight and yield % are both editable — whichever was typed last
 * drives the calculation (finished = input × yield % ÷ 100, or the weighed batch).
 * Neither ever changes an ingredient quantity.
 */
export function EditorWeightSummary({
  summary,
  displayUnit,
  inputGrams,
  finishedGrams,
  yieldDraft,
  onYieldChange,
  problem,
  reviewNeeded,
  expanded,
  onToggle,
}: {
  summary: WeightSummary;
  displayUnit: WeightDisplayUnit;
  /** Ingredient input grams (null when it can't be added up). */
  inputGrams: number | null;
  /** Finished weight the draft implies (null when unknown). */
  finishedGrams: number | null;
  yieldDraft: YieldDraft;
  onYieldChange: (patch: Partial<YieldDraft>) => void;
  problem: string | null;
  reviewNeeded: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('recipes.editor.weight');
  const weight = useWeightLabel();
  const panelId = React.useId();

  // The finished-weight field shows the measured grams (measured mode) or the
  // computed finished weight (percent mode) in the display unit; while focused it
  // keeps the raw typed text so "0," isn't reformatted mid-keystroke.
  const computedText =
    yieldDraft.mode === 'measured'
      ? (() => {
          const grams = Number(yieldDraft.measuredText);
          return yieldDraft.measuredText !== '' && Number.isFinite(grams) ? formatWeightForUnit(grams, displayUnit) : '';
        })()
      : finishedGrams !== null
        ? formatWeightForUnit(finishedGrams, displayUnit)
        : '';
  const [finishedText, setFinishedText] = React.useState(computedText);
  const [finishedFocused, setFinishedFocused] = React.useState(false);
  React.useEffect(() => {
    if (!finishedFocused) setFinishedText(computedText);
  }, [computedText, finishedFocused]);

  // A weighed batch implies a yield % — show it, so the two fields never disagree.
  const measuredGrams = yieldDraft.measuredText === '' ? null : Number(yieldDraft.measuredText);
  const impliedPercent =
    yieldDraft.mode === 'measured' && inputGrams !== null && measuredGrams !== null && measuredGrams > 0
      ? Math.round((measuredGrams / inputGrams) * 100)
      : null;

  const showFinishedLine =
    !expanded && finishedGrams !== null && (summary.state !== 'complete' || Math.abs(finishedGrams - summary.totalGrams) >= 0.01);

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface-2/70 px-4 py-3">
      <WeightSummaryLine summary={summary} displayUnit={displayUnit}>
        {summary.state !== 'empty' ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={onToggle}
            className="-my-1 inline-flex min-h-9 items-center gap-1 rounded-full px-2 text-sm font-medium text-accent-700 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-accent-300"
          >
            {expanded ? t('hide') : t('adjust')}
            <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} aria-hidden />
          </button>
        ) : null}
      </WeightSummaryLine>

      {showFinishedLine ? (
        <p className="text-xs text-muted-foreground">
          {t('finishedLine', { weight: weight(finishedGrams, displayUnit) })}
          {' · '}
          {yieldDraft.mode === 'measured' ? t('measured') : t('calculated')}
        </p>
      ) : null}
      {reviewNeeded ? <p className="text-xs text-amber-800 dark:text-amber-300">{t('reviewNeeded')}</p> : null}

      {expanded ? (
        <div id={panelId} className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('ingredientTotal')}</span>
            <span className="flex h-10 items-center rounded-lg bg-surface px-3 font-medium tabular-nums">
              {inputGrams !== null ? weight(inputGrams, displayUnit) : '—'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${panelId}-percent`} className="text-xs font-normal text-muted-foreground">
              {t('yieldPercent')}
            </Label>
            <div className="relative">
              <Input
                id={`${panelId}-percent`}
                inputMode="numeric"
                value={impliedPercent !== null ? String(impliedPercent) : yieldDraft.percentText}
                aria-invalid={yieldDraft.mode === 'percent' && problem !== null}
                onChange={(e) => onYieldChange({ percentText: e.target.value, mode: 'percent' })}
                className="pr-8 text-right tabular-nums"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${panelId}-finished`} className="text-xs font-normal text-muted-foreground">
              {t('finished')}
            </Label>
            <div className="relative">
              <Input
                id={`${panelId}-finished`}
                inputMode="decimal"
                value={finishedText}
                aria-invalid={yieldDraft.mode === 'measured' && problem !== null}
                onFocus={() => setFinishedFocused(true)}
                onBlur={() => {
                  setFinishedFocused(false);
                  setFinishedText(computedText);
                }}
                onChange={(e) => {
                  setFinishedText(e.target.value);
                  if (e.target.value.trim() === '') {
                    onYieldChange({ measuredText: '', mode: 'measured' });
                    return;
                  }
                  const grams = parseWeightInput(e.target.value, displayUnit);
                  if (grams !== null) {
                    onYieldChange({ measuredText: String(Math.round(grams * 100) / 100), mode: 'measured' });
                  }
                }}
                className="pr-9 text-right tabular-nums"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                {displayUnit}
              </span>
            </div>
          </div>
          {problem ? <p className="text-xs text-red-700 dark:text-red-300 sm:col-span-3">{problem}</p> : null}
          {yieldDraft.mode === 'percent' && inputGrams === null && summary.state === 'partial' ? (
            <p className="text-xs text-muted-foreground sm:col-span-3">{t('weighBatch')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
