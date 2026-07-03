'use client';

import type { Action, ComponentProps } from '@flows/react';
import { Card } from '@/components/ui/card';
import { FlowsActionButton, FlowsDismissButton } from './shared';

/**
 * PrepProfit-styled Flows tooltip/callout block (dashboard component key
 * `PrepProfitTooltip`). A compact contextual note — Flows handles slot placement, so
 * this renders a small self-contained card rather than owning any anchoring/positioning.
 * Copy is owner-authored and arrives via props.
 */
type PrepProfitTooltipProps = {
  title?: string;
  body?: string;
  action?: Action;
  dismiss?: Action;
};

export function PrepProfitTooltip({
  title,
  body,
  action,
  dismiss,
}: ComponentProps<PrepProfitTooltipProps>) {
  if (!title && !body) return null;

  return (
    <Card className="flex max-w-xs flex-col gap-2 p-3 shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          {title && (
            <span className="text-sm font-semibold text-foreground">{title}</span>
          )}
          {body && <p className="text-xs text-muted-foreground">{body}</p>}
        </div>
        <FlowsDismissButton action={dismiss} />
      </div>
      {action && (
        <div>
          <FlowsActionButton action={action} />
        </div>
      )}
    </Card>
  );
}
