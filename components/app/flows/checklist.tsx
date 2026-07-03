'use client';

import { Check, Circle } from 'lucide-react';
import type { Action, ComponentProps } from '@flows/react';
import { Card } from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { FlowsActionButton, FlowsDismissButton } from './shared';

/**
 * PrepProfit-styled Flows onboarding checklist (dashboard component key
 * `PrepProfitChecklist`). Persistent activation guidance for the reverse trial: each
 * item's `completed` state is DRIVEN BY user properties on the Flows dashboard side
 * (e.g. `recipeCount >= 1`), so imports, refreshes, and cross-device sessions all stay
 * correct without an imperative call. This component only renders the resolved list.
 */
type ChecklistItem = {
  label?: string;
  description?: string;
  completed?: boolean;
  /** CTA for an incomplete item (e.g. "Add an ingredient" → /ingredients). */
  action?: Action;
};

type PrepProfitChecklistProps = {
  title?: string;
  description?: string;
  items?: ChecklistItem[];
  dismiss?: Action;
};

export function PrepProfitChecklist({
  title,
  description,
  items,
  dismiss,
}: ComponentProps<PrepProfitChecklistProps>) {
  const t = useTranslations('flowsOnboarding');
  const list = Array.isArray(items) ? items.filter((i) => i?.label) : [];
  if (list.length === 0) return null;

  const done = list.filter((i) => i.completed).length;
  const percent = Math.round((done / list.length) * 100);

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          {title && (
            <span className="font-display text-base font-semibold text-foreground">
              {title}
            </span>
          )}
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <FlowsDismissButton action={dismiss} />
      </div>

      {/* Progress */}
      <div className="flex items-center gap-3">
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-accent-500 transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {t('progress', { done, total: list.length })}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {list.map((item, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface p-2.5"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              {item.completed ? (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                  <Check className="size-3.5" aria-label={t('stepDone')} />
                </span>
              ) : (
                <Circle
                  className="size-5 shrink-0 text-muted-foreground/50"
                  aria-label={t('stepTodo')}
                />
              )}
              <div className="flex min-w-0 flex-col">
                <span
                  className={
                    item.completed
                      ? 'truncate text-sm text-muted-foreground line-through'
                      : 'truncate text-sm font-medium text-foreground'
                  }
                >
                  {item.label}
                </span>
                {item.description && !item.completed && (
                  <span className="truncate text-xs text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </div>
            </div>
            {!item.completed && (
              <FlowsActionButton
                action={item.action}
                variant="outline"
                className="shrink-0"
              />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
