'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import type { Action } from '@flows/react';
import { Button, type ButtonProps } from '@/components/ui/button';

/**
 * Shared building blocks for the PrepProfit custom Flows components. Not registered as
 * Flows components themselves (the barrel `index.ts` re-exports only the four block
 * components), so they never collide with a dashboard component key.
 *
 * The Flows `Action` shape ({@link Action}) is what a dashboard block template sends for
 * a button/link: a `label`, an optional `url`, `openInNew`, and a `callAction` that
 * records the block transition. We render the label as a real link when a `url` is set
 * (client-side for internal, `<a target="_blank">` when `openInNew`), and always fire
 * `callAction` so the workflow advances/exits. All fields are treated as optional at
 * runtime — a minimally-configured block must never crash the app.
 */

/** A Flows action rendered as a PrepProfit button (link when the action carries a url). */
export function FlowsActionButton({
  action,
  variant,
  size = 'sm',
  className,
}: {
  action?: Action;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
}) {
  if (!action?.label) return null;
  const fire = () => {
    void action.callAction?.();
  };

  if (action.url) {
    // External / new-tab links bypass the client router (Flows convention).
    if (action.openInNew) {
      return (
        <Button asChild variant={variant} size={size} className={className}>
          <a href={action.url} target="_blank" rel="noreferrer" onClick={fire}>
            {action.label}
          </a>
        </Button>
      );
    }
    return (
      <Button asChild variant={variant} size={size} className={className}>
        <Link href={action.url} onClick={fire}>
          {action.label}
        </Link>
      </Button>
    );
  }

  return (
    <Button variant={variant} size={size} className={className} onClick={fire}>
      {action.label}
    </Button>
  );
}

/** Small ghost "×" that exits the block via its Flows dismiss action. Renders nothing
 *  when the block has no dismiss action wired. */
export function FlowsDismissButton({ action }: { action?: Action }) {
  const t = useTranslations('flowsOnboarding');
  if (!action) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="size-8 shrink-0 px-0 text-muted-foreground"
      aria-label={t('dismiss')}
      onClick={() => void action.callAction?.()}
    >
      <X className="size-4" />
    </Button>
  );
}
