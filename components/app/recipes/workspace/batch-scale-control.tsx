'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatScaleFactor, parseScaleFactor } from '@/lib/calculations/recipeScale';

/**
 * "Scale recipe": a directly editable multiplier of the SAVED recipe (0,75 = 75%,
 * 3 or 3x = three times, 1 = the original). A temporary kitchen calculation —
 * quantities update as you type, nothing is ever saved, and "Reset to 1×" brings
 * back the original amounts. Invalid input keeps the last valid factor on screen
 * and says what's wrong.
 */
export function BatchScaleControl({
  factor,
  onFactorChange,
}: {
  factor: number;
  onFactorChange: (factor: number) => void;
}) {
  const t = useTranslations('recipes.workspace.scaleField');
  const inputId = React.useId();
  const hintId = React.useId();
  const [text, setText] = React.useState(formatScaleFactor(factor));
  const [focused, setFocused] = React.useState(false);

  // A factor set elsewhere (tapping a quantity to scale to it) updates the field,
  // but never while the cook is typing in it.
  React.useEffect(() => {
    if (focused) return;
    const parsed = parseScaleFactor(text);
    if (!parsed.ok || parsed.factor !== factor) setText(formatScaleFactor(factor));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to external factor changes
  }, [factor, focused]);

  const parsed = parseScaleFactor(text);
  const error = parsed.ok ? null : t(`errors.${parsed.reason}`);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={inputId} className="text-sm font-medium">
          {t('label')}
        </Label>
        <div className="relative">
          <Input
            id={inputId}
            inputMode="decimal"
            value={text}
            aria-invalid={error !== null}
            aria-describedby={hintId}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (!parseScaleFactor(text).ok) setText(formatScaleFactor(factor));
            }}
            onChange={(e) => {
              setText(e.target.value);
              const next = parseScaleFactor(e.target.value);
              if (next.ok) onFactorChange(next.factor);
            }}
            className="h-10 w-28 pr-7 text-right text-base tabular-nums"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            ×
          </span>
        </div>
        {factor !== 1 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onFactorChange(1);
              setText('1');
            }}
          >
            <RotateCcw className="size-4" aria-hidden />
            {t('reset')}
          </Button>
        )}
      </div>
      <p id={hintId} className={error ? 'text-xs text-red-700 dark:text-red-300' : 'text-xs text-muted-foreground'}>
        {error ?? (factor === 1 ? t('hintOriginal') : t('hintScaled', { percent: formatScaleFactor(factor * 100) }))}
      </p>
    </div>
  );
}
