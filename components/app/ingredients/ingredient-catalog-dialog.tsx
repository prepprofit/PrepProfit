'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createIngredientFromCatalogAction,
  searchIngredientCatalogAction,
} from '@/app/(app)/ingredients/catalog-actions';
import type { CatalogEntry } from '@/lib/ingredient-catalog/schema';
import type { Ingredient } from '@/lib/db/schema';
import type { KitchenIngredient } from '@/lib/data/ingredients';
import type { AllergenTag } from '@/lib/data/allergens';

/**
 * Seed ingredient catalogue picker (docs/ingredient-seed-catalog-plan.md §6
 * Slice 4). OPERATIONAL — both roles use it, one-click create; the server
 * always creates at priceCents 0 + needsPricing true and seeds the typical
 * allergens as UNREVIEWED. Debounced server-side search (the ~1.9k dataset
 * never ships to the browser). Built on the native `<dialog>`, mirroring
 * IngredientAllergenDialog.
 */
export function IngredientCatalogDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (
    ingredient: Ingredient | KitchenIngredient,
    allergens: AllergenTag[],
  ) => void;
}) {
  const t = useTranslations('ingredients.catalog');
  const tDim = useTranslations('dimensions');
  const tAllergenNames = useTranslations('allergens.labels');
  const actionError = useActionError();
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const [term, setTerm] = React.useState('');
  const [results, setResults] = React.useState<CatalogEntry[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [addedIds, setAddedIds] = React.useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // Reset on open so a previous session's results/added marks don't linger.
  React.useEffect(() => {
    if (!open) return;
    setTerm('');
    setResults([]);
    setError(null);
    setAddedIds(new Set());
  }, [open]);

  // Debounced server-side search.
  React.useEffect(() => {
    if (!open) return;
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      startTransition(async () => {
        const result = await searchIngredientCatalogAction({ term: trimmed });
        setSearching(false);
        if (result.ok) {
          setError(null);
          setResults(result.data.entries);
        } else {
          setError(actionError(result.code));
        }
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [term, open, actionError]);

  const onAdd = (entry: CatalogEntry) => {
    setError(null);
    setPendingId(entry.id);
    startTransition(async () => {
      const result = await createIngredientFromCatalogAction({
        catalogId: entry.id,
      });
      setPendingId(null);
      if (result.ok) {
        setAddedIds((prev) => new Set(prev).add(entry.id));
        onCreated(result.data.ingredient, result.data.allergens);
      } else {
        setError(actionError(result.code));
      }
    });
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (pendingId === null) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && pendingId === null) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-xl rounded-2xl border border-border bg-surface p-0 text-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>

        <Input
          type="search"
          autoFocus
          aria-label={t('searchPlaceholder')}
          placeholder={t('searchPlaceholder')}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <div className="max-h-[50vh] min-h-24 overflow-y-auto pr-1">
          {results.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {searching
                ? t('searching')
                : term.trim().length < 2
                  ? t('hint')
                  : t('noResults')}
            </p>
          )}
          <ul className="flex flex-col divide-y divide-border">
            {results.map((entry) => {
              const added = addedIds.has(entry.id);
              return (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm text-foreground">
                      {entry.nameEn}
                    </span>
                    <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <span>{tDim(entry.dimension)}</span>
                      {entry.allergens.map((tag) => (
                        <span
                          key={tag.allergen}
                          className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                          title={t('typicalAllergen')}
                        >
                          {tAllergenNames(tag.allergen)}
                        </span>
                      ))}
                    </span>
                  </div>
                  {added ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-brand-700 dark:text-brand-300"
                      role="status"
                    >
                      <Check className="size-4" />
                      {t('added')}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pendingId !== null}
                      onClick={() => onAdd(entry)}
                    >
                      <Plus className="size-4" />
                      {t('add')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
          {t('disclaimer')}
        </p>

        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pendingId !== null}
          >
            {t('close')}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
