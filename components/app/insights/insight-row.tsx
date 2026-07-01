'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, Sparkles, X, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  explainProfitLeakAction,
  dismissInsightAction,
  restoreInsightAction,
} from '@/app/(app)/insights/actions';
import type { ProfitLeakSeverity } from '@/lib/calculations/profit-leaks';
import type { ProfitLeakExplanationData } from '@/lib/ai/operation-types';

export type InsightRowData = {
  fingerprint: string;
  label: string;
  href: string;
  severity: ProfitLeakSeverity;
  explanation: ProfitLeakExplanationData | null;
  dismissed: boolean;
};

const DOT: Record<ProfitLeakSeverity, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-muted-foreground/50',
};

const RISK_TONE: Record<ProfitLeakExplanationData['riskLevel'], string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  low: 'bg-muted text-muted-foreground',
};

/**
 * One finding in the Profit Insight Inbox (Sprint 4). Client component: the finding
 * text/link is rendered server-side and passed in; this adds the AI "Explain" action
 * (the paid, quota-metered call), the cached explanation card, and dismiss/restore. A
 * failed or quota-blocked explanation never hides the finding — only an inline message
 * appears.
 */
export function InsightRow({ data }: { data: InsightRowData }) {
  const t = useTranslations('insights');
  const actionError = useActionError();
  const [pending, startTransition] = React.useTransition();
  const [explanation, setExplanation] = React.useState(data.explanation);
  const [error, setError] = React.useState<string | null>(null);

  const explain = () => {
    setError(null);
    startTransition(async () => {
      const res = await explainProfitLeakAction(data.fingerprint);
      if (res.ok) setExplanation(res.data.explanation);
      else setError(actionError(res.code));
    });
  };

  const toggleDismiss = () => {
    setError(null);
    startTransition(async () => {
      const res = data.dismissed
        ? await restoreInsightAction(data.fingerprint)
        : await dismissInsightAction(data.fingerprint);
      if (!res.ok) setError(actionError(res.code));
    });
  };

  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <span
          className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[data.severity])}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            href={data.href}
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:underline"
          >
            <span className="truncate">{data.label}</span>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </Link>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!data.dismissed && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={explain}
              disabled={pending}
            >
              <Sparkles className="size-3.5" aria-hidden />
              {explanation ? t('explainAgain') : t('explain')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleDismiss}
            disabled={pending}
            aria-label={data.dismissed ? t('restore') : t('dismiss')}
            title={data.dismissed ? t('restore') : t('dismiss')}
          >
            {data.dismissed ? (
              <RotateCcw className="size-3.5" aria-hidden />
            ) : (
              <X className="size-3.5" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {error && <p className="pl-5 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {explanation && (
        <div className="ml-5 rounded-lg border border-border bg-muted/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">{explanation.headline}</p>
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                RISK_TONE[explanation.riskLevel],
              )}
            >
              {t(`riskLevel.${explanation.riskLevel}`)}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">{explanation.explanation}</p>
          <p className="mt-2 text-sm font-medium text-accent-700 dark:text-accent-300">
            {explanation.actionLabel}
          </p>
        </div>
      )}
    </div>
  );
}
