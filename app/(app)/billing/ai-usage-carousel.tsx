'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { AiUsageRow } from '@/lib/data/ai-usage';
import { AI_USAGE_FEATURE_LABEL_KEY } from '@/lib/ai/usage-features';
import { cn } from '@/lib/utils';

/**
 * Client carousel over the metered AI features (one visible at a time). Left/right
 * arrows cycle through Photo recipe extraction, Weekly CFO report, etc. DISPLAY only —
 * the numbers come from {@link AiUsageRow}s projected server-side; caps stay enforced
 * server-side. The parent panel filters to features the plan actually grants.
 */
export function AiUsageCarousel({ rows }: { rows: AiUsageRow[] }) {
  const t = useTranslations('billing.aiUsage');
  const [index, setIndex] = React.useState(0);

  const go = (delta: number) =>
    setIndex((prev) => (prev + delta + rows.length) % rows.length);

  // Guard against an out-of-range index if `rows` ever shrinks between renders.
  const active = rows.length > 0 ? index % rows.length : 0;
  const row = rows[active];
  const many = rows.length > 1;
  if (!row) return null;

  // Truthful bar: clamp to 100% even when a downgrade left `used > limit`.
  const percent = Math.min(100, Math.round((row.used / row.limit) * 100));
  const inFlight = row.reserved - row.used;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        {many && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label={t('previousFeature')}
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
            <span className="font-medium text-foreground">
              {t(AI_USAGE_FEATURE_LABEL_KEY[row.feature])}
            </span>
            <span className="text-muted-foreground">
              {t('used', { used: row.used, limit: row.limit })}
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuenow={row.used}
            aria-valuemin={0}
            aria-valuemax={row.limit}
          >
            <div
              className="h-full rounded-full bg-accent-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
            <span>{t('remaining', { count: row.remaining })}</span>
            {inFlight > 0 && <span>{t('inFlight', { count: inFlight })}</span>}
          </div>
        </div>

        {many && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label={t('nextFeature')}
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>

      {/* Dots: which feature you're on and how many there are. */}
      {many && (
        <div className="flex items-center justify-center gap-1.5">
          {rows.map((r, i) => (
            <button
              key={r.feature}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={t(AI_USAGE_FEATURE_LABEL_KEY[r.feature])}
              aria-current={i === active ? 'true' : undefined}
              className={cn(
                'size-1.5 cursor-pointer rounded-full transition-colors',
                i === active
                  ? 'bg-accent-500'
                  : 'bg-surface-2 hover:bg-muted-foreground/40',
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
