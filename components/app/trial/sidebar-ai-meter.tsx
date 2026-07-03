'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { SidebarAiMeterView } from '@/lib/data/ai-usage';

/**
 * Compact photo-extraction usage meter for the expanded sidebar footer (manager-only).
 * Presentational: it renders the already-projected {@link SidebarAiMeterView} — a thin
 * progress bar, `used / limit` count, and a source-driven CTA. `onNavigate` closes the
 * mobile drawer after the CTA is tapped. Never enforces a cap; DISPLAY only.
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

      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">
          {tUsage('features.photo_recipe_extraction')}
        </span>
        <span className="shrink-0 tabular-nums">
          {tUsage('used', { used: view.used, limit: view.limit })}
        </span>
      </div>

      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuenow={view.used}
        aria-valuemin={0}
        aria-valuemax={view.limit}
      >
        <div
          className="h-full rounded-full bg-accent-500"
          style={{ width: `${view.percent}%` }}
        />
      </div>
    </div>
  );
}
