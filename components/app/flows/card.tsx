'use client';

import { Sparkles } from 'lucide-react';
import type { Action, ComponentProps } from '@flows/react';
import { Card } from '@/components/ui/card';
import { FlowsActionButton, FlowsDismissButton } from './shared';

/**
 * PrepProfit-styled Flows "card" block (dashboard component key `PrepProfitCard`). A
 * quiet B2B status/nudge surface matching `DashboardTrialCard` — accent-tinted card, one
 * heading, a line of copy, an optional CTA, and an optional dismiss. All copy is
 * owner-authored in the Flows dashboard and arrives via props (kept editable there);
 * this component owns only layout + a11y strings.
 */
type PrepProfitCardProps = {
  title?: string;
  body?: string;
  primaryAction?: Action;
  dismiss?: Action;
};

export function PrepProfitCard({
  title,
  body,
  primaryAction,
  dismiss,
}: ComponentProps<PrepProfitCardProps>) {
  // A block with no copy at all is a misconfiguration — render nothing rather than an
  // empty card.
  if (!title && !body) return null;

  return (
    <Card className="flex flex-col items-start gap-4 border-accent-200 bg-accent-50 p-4 sm:flex-row sm:items-center sm:gap-5 dark:border-accent-500/20 dark:bg-accent-500/10">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-600 text-white">
        <Sparkles className="size-4" aria-hidden />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && (
          <span className="font-display text-base font-semibold text-foreground">
            {title}
          </span>
        )}
        {body && <p className="text-sm text-muted-foreground">{body}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <FlowsActionButton action={primaryAction} />
        <FlowsDismissButton action={dismiss} />
      </div>
    </Card>
  );
}
