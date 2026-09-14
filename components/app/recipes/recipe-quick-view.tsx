'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useActionError } from '@/lib/i18n/use-action-error';
import { getRecipeQuickViewAction } from '@/app/(app)/recipes/quick-view-actions';
import type { RecipeDocument } from '@/lib/recipes/recipe-document';

/**
 * Lightweight recipe preview opened from the recipe list: name, what it makes, the
 * ingredients with quantities (saved order) and the preparation method. Money-free
 * for every role. The list stays mounted underneath, so closing returns to the same
 * search, sort and scroll position.
 */
export function RecipeQuickView({
  recipeId,
  onClose,
  onOpen,
}: {
  recipeId: string | null;
  onClose: () => void;
  /** Called before navigating to the full recipe (remembers the list). */
  onOpen: () => void;
}) {
  const t = useTranslations('recipes.quickView');
  const actionError = useActionError();
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const [doc, setDoc] = React.useState<RecipeDocument | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (recipeId && !el.open) el.showModal();
    else if (!recipeId && el.open) el.close();
  }, [recipeId]);

  React.useEffect(() => {
    if (!recipeId) return;
    let cancelled = false;
    setDoc(null);
    setError(null);
    void getRecipeQuickViewAction(recipeId).then((result) => {
      if (cancelled) return;
      if (result.ok) setDoc(result.data);
      else setError(actionError(result.code));
    });
    return () => {
      cancelled = true;
    };
  }, [recipeId, actionError]);

  const output = doc
    ? [
        doc.output.yieldQuantity != null && doc.output.yieldUnit
          ? t('makes', { amount: String(doc.output.yieldQuantity), unit: doc.output.yieldUnit })
          : null,
        doc.output.finishedWeightGrams != null ? t('finishedWeight', { grams: String(doc.output.finishedWeightGrams) }) : null,
      ].filter((p): p is string => p !== null)
    : [];

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl rounded-2xl border border-border bg-surface p-0 text-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="font-display text-xl font-semibold text-foreground">
              {doc?.name ?? t('loading')}
            </h2>
            {output.length > 0 && <p className="text-sm text-muted-foreground">{output.join(' · ')}</p>}
          </div>
          <button
            type="button"
            aria-label={t('close')}
            title={t('close')}
            onClick={onClose}
            className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
          {error ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : !doc ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t('loading')}
            </p>
          ) : (
            <>
              <section aria-labelledby={`${titleId}-ingredients`}>
                <h3 id={`${titleId}-ingredients`} className="mb-2 text-sm font-semibold text-foreground">
                  {t('ingredients')}
                </h3>
                {doc.lines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('noIngredients')}</p>
                ) : (
                  <ul className="divide-y divide-border rounded-xl border border-border">
                    {doc.lines.map((line) => (
                      <li key={line.key} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0 text-foreground">
                          {line.name}
                          {line.isSubRecipe && <span className="ml-2 text-xs text-muted-foreground">{t('subRecipe')}</span>}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums text-foreground">
                          {line.amount} {line.unit}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section aria-labelledby={`${titleId}-method`}>
                <h3 id={`${titleId}-method`} className="mb-2 text-sm font-semibold text-foreground">
                  {t('method')}
                </h3>
                {doc.method.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('noMethod')}</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {doc.method.map((section, si) => (
                      <div key={si}>
                        {section.title && <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.title}</p>}
                        <ol className="flex flex-col gap-2">
                          {section.steps.map((step, i) => (
                            <li key={i} className="flex gap-3 text-sm">
                              <span className="mt-0.5 size-6 shrink-0 rounded-full bg-surface-2 text-center text-xs font-medium leading-6">
                                {i + 1}
                              </span>
                              <p className="min-w-0 whitespace-pre-wrap text-foreground">{step}</p>
                            </li>
                          ))}
                        </ol>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
          {recipeId && (
            <Button asChild>
              <Link href={`/recipes/${recipeId}`} onClick={onOpen}>
                {t('openRecipe')}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}
