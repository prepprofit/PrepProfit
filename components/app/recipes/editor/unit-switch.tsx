'use client';

import type { WeightDisplayUnit } from '@/lib/format/weight';
import { cn } from '@/lib/utils';

/**
 * The ONE g / kg switch beside the Ingredients heading. Small visually, but each
 * option keeps a comfortable touch target. Presentation only: flipping it never
 * changes a stored quantity.
 */
export function UnitSwitch({
  value,
  onChange,
  label,
}: {
  value: WeightDisplayUnit;
  onChange: (unit: WeightDisplayUnit) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full border border-border bg-surface p-0.5 text-xs font-semibold">
      {(['g', 'kg'] as const).map((unit) => (
        <button
          key={unit}
          type="button"
          role="radio"
          aria-checked={value === unit}
          onClick={() => onChange(unit)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const next = unit === 'g' ? 'kg' : 'g';
              onChange(next);
              (e.currentTarget.parentElement?.querySelector(`[data-unit="${next}"]`) as HTMLButtonElement | null)?.focus();
            }
          }}
          tabIndex={value === unit ? 0 : -1}
          data-unit={unit}
          className={cn(
            'relative min-w-10 rounded-full px-3 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            // Invisible hit-area extension keeps the tap target ~40px tall.
            'before:absolute before:-inset-y-2 before:inset-x-0',
            value === unit ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {unit}
        </button>
      ))}
    </div>
  );
}
