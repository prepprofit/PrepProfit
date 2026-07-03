'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { SidebarAiMeterView } from '@/lib/data/ai-usage';
import { AI_USAGE_FEATURE_LABEL_KEY } from '@/lib/ai/usage-features';
import { cn } from '@/lib/utils';

/**
 * Compact AI-usage meter for the expanded sidebar footer (manager-only). Presentational:
 * it renders the already-projected {@link SidebarAiMeterView} — one metered feature at a
 * time (progress bar + `used / limit`) with left/right arrows to page through the rest,
 * plus a source-driven CTA. `onNavigate` closes the mobile drawer after the CTA is
 * tapped. Never enforces a cap; DISPLAY only.
 */
export function SidebarAiMeter({
  view,
  onNavigate,
}: {
  view: SidebarAiMeterView;
  onNavigate?: () => void;
}) {
  const t = useTranslations('trial.sidebar');
  const tUsage = useTranslations('billing.aiUsage');
  const [index, setIndex] = React.useState(0);

  const { features } = view;
  const active = features.length > 0 ? index % features.length : 0;
  const feature = features[active];
  const many = features.length > 1;

  const go = (delta: number) =>
    setIndex((prev) => (prev + delta + features.length) % features.length);

  if (!feature) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2/50 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{t('title')}</span>
        {view.cta && (
          <Link
            href={view.cta.href}
            onClick={onNavigate}
            className="text-xs font-medium text-accent-700 underline-offset-2 hover:underline dark:text-accent-300"
          >
            {view.cta.labelKey === 'managePlan' ? t('managePlan') : t('upgrade')}
          </Link>
        )}
      </div>

      {/* Feature name on its own full-width line so long names stay readable
          (wraps rather than truncating); usage count sits to its right. */}
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">
          {tUsage(AI_USAGE_FEATURE_LABEL_KEY[feature.feature])}
        </span>
        <span className="shrink-0 tabular-nums">
          {tUsage('used', { used: feature.used, limit: feature.limit })}
        </span>
      </div>

      {/* Arrows flank the bar (not the label), keeping the name full-width. */}
      <div className="flex items-center gap-1.5">
        {many && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label={tUsage('previousFeature')}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-3.5" />
          </button>
        )}

        <div
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={feature.used}
          aria-valuemin={0}
          aria-valuemax={feature.limit}
        >
          <div
            className="h-full rounded-full bg-accent-500"
            style={{ width: `${feature.percent}%` }}
          />
        </div>

        {many && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label={tUsage('nextFeature')}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight className="size-3.5" />
          </button>
        )}
      </div>

      {/* Dots: which feature you're on and how many there are. */}
      {many && (
        <div className="flex items-center justify-center gap-1">
          {features.map((f, i) => (
            <button
              key={f.feature}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={tUsage(AI_USAGE_FEATURE_LABEL_KEY[f.feature])}
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
