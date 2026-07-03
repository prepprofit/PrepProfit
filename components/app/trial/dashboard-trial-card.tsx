import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { TrialView } from '@/lib/trial';

/**
 * Dashboard reverse-trial status strip (manager-only, active trial only). A compact
 * horizontal product-status row — a day-count tile, one line of copy, and an upgrade
 * CTA — not a marketing hero. The dashboard page renders it after its manager +
 * onboarding guards, so this component assumes an authorized viewer on an active trial.
 */
export async function DashboardTrialCard({ trial }: { trial: TrialView }) {
  const t = await getTranslations('trial');

  return (
    <Card className="flex flex-col items-start gap-4 border-accent-200 bg-accent-50 p-4 sm:flex-row sm:items-center sm:gap-5 dark:border-accent-500/20 dark:bg-accent-500/10">
      <div className="flex shrink-0 flex-col items-center justify-center rounded-lg bg-accent-600 px-4 py-2 text-white">
        <span className="font-display text-2xl font-semibold leading-none tabular-nums">
          {trial.endsToday ? '0' : trial.daysLeft}
        </span>
        <span className="mt-1 text-[10px] font-medium uppercase tracking-wider text-white/80">
          {t('daysLeft', { days: trial.daysLeft })}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 font-display text-base font-semibold text-foreground">
          <Sparkles className="size-4 text-accent-600" aria-hidden />
          {t('card.title')}
        </span>
        <p className="text-sm text-muted-foreground">{t('card.subtitle')}</p>
      </div>

      <Button asChild size="sm" className="shrink-0">
        <Link href="/pricing">{t('card.cta')}</Link>
      </Button>
    </Card>
  );
}
