'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useActionError } from '@/lib/i18n/use-action-error';
import { summarizeDailyCloseAction } from '@/app/(app)/sales/actions';
import type { DailyCloseSummary } from '@/lib/ai/daily-close-summary';

/**
 * AI Daily Close Summary card (Sprint 6, AI margin roadmap). Rendered on a POSTED close.
 * Manager-only + quota-metered: the paid provider call runs only on an explicit click, so
 * the deterministic close figures are always visible whether or not the manager asks for a
 * summary. A failed or quota-blocked call never hides the close — only an inline message
 * appears. There is no cache, so re-summarizing spends another quota slot (an explicit
 * "Refresh" action).
 */
const RISK_TONE: Record<DailyCloseSummary['riskLevel'], string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  low: 'bg-muted text-muted-foreground',
};

export function DailyCloseSummaryCard({ saleId }: { saleId: string }) {
  const t = useTranslations('sales.summary');
  const actionError = useActionError();
  const [pending, startTransition] = React.useTransition();
  const [summary, setSummary] = React.useState<DailyCloseSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const summarize = () => {
    setError(null);
    startTransition(async () => {
      const res = await summarizeDailyCloseAction(saleId);
      if (res.ok) setSummary(res.data.summary);
      else setError(actionError(res.code));
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="inline-flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden />
          {t('title')}
        </CardTitle>
        <Button type="button" variant="outline" size="sm" onClick={summarize} disabled={pending}>
          {summary ? t('refresh') : t('generate')}
        </Button>
      </CardHeader>
      <CardContent className="text-sm">
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}

        {!summary && !error && (
          <p className="text-muted-foreground">{t('empty')}</p>
        )}

        {summary && (
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-foreground">{summary.headline}</p>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                  RISK_TONE[summary.riskLevel],
                )}
              >
                {t(`riskLevel.${summary.riskLevel}`)}
              </span>
            </div>
            <p className="text-muted-foreground">{summary.summary}</p>
            {summary.highlights.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {summary.highlights.map((h, i) => (
                  <li key={i} className="flex gap-2 text-muted-foreground">
                    <span aria-hidden className="text-accent-600 dark:text-accent-400">
                      •
                    </span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs text-muted-foreground/80">{t('disclaimer')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
