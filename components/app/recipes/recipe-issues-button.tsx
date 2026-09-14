'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';

export const RECIPE_ISSUES = [
  'allergensUnreviewed',
  'nutritionIncomplete',
  'needsPricing',
  'missingFinishedWeight',
] as const;
export type RecipeIssue = (typeof RECIPE_ISSUES)[number];

/**
 * A small "!" shown only when a recipe has something to fix. Clicking it explains
 * the actual issues in a popover, so the list itself stays calm. Clicks never reach
 * the row (which would open the recipe).
 */
export function RecipeIssuesButton({ name, issues }: { name: string; issues: RecipeIssue[] }) {
  const t = useTranslations('recipes.issues');
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const panelId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (issues.length === 0) return null;

  return (
    <div
      ref={ref}
      className="relative inline-flex"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label={t('open', { name, count: issues.length })}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-amber-600 transition-colors hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-400 dark:hover:bg-amber-500/15"
      >
        <AlertCircle className="size-[18px]" aria-hidden />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t('title')}
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-xl border border-border bg-surface p-3 text-left shadow-lg"
        >
          <p className="mb-2 text-sm font-medium text-foreground">{t('title')}</p>
          <ul className="flex flex-col gap-2">
            {issues.map((issue) => (
              <li key={issue} className="flex flex-col">
                <span className="text-sm text-foreground">{t(`${issue}.label`)}</span>
                <span className="text-xs text-muted-foreground">{t(`${issue}.help`)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
