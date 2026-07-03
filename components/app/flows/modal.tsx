'use client';

import { Sparkles } from 'lucide-react';
import type { Action, ComponentProps } from '@flows/react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { FlowsActionButton } from './shared';

/**
 * PrepProfit-styled Flows modal block (dashboard component key `PrepProfitModal`). A
 * focused announcement/step dialog rendered on its own surface inside the transparent
 * Radix positioning wrapper. Flows mounts/unmounts the component to control visibility,
 * so it is always `open`; closing it (overlay, escape, close button, or CTA) exits the
 * block via the `dismiss` action. Copy is owner-authored and arrives via props.
 */
type PrepProfitModalProps = {
  title?: string;
  body?: string;
  primaryAction?: Action;
  secondaryAction?: Action;
  dismiss?: Action;
};

export function PrepProfitModal({
  title,
  body,
  primaryAction,
  secondaryAction,
  dismiss,
}: ComponentProps<PrepProfitModalProps>) {
  if (!title && !body) return null;

  const exit = () => {
    void dismiss?.callAction?.();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) exit();
      }}
    >
      <DialogContent className="max-w-md">
        <div className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-6 shadow-xl">
          <span className="flex size-10 items-center justify-center rounded-full bg-accent-50 dark:bg-accent-500/10">
            <Sparkles className="size-5 text-accent-600 dark:text-accent-400" aria-hidden />
          </span>

          <div className="flex flex-col gap-1.5">
            {title && (
              <DialogTitle className="font-display text-lg font-semibold text-foreground">
                {title}
              </DialogTitle>
            )}
            {body && (
              <DialogDescription className="text-sm text-muted-foreground">
                {body}
              </DialogDescription>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FlowsActionButton action={primaryAction} size="default" />
            <FlowsActionButton
              action={secondaryAction}
              variant="outline"
              size="default"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
