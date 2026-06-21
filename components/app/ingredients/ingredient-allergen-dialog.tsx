'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ALLERGEN_CATALOG, type AllergenSlug, type Presence } from '@/lib/allergens/catalog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { setIngredientAllergensAction } from '@/app/(app)/ingredients/allergen-actions';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { AllergenTag } from '@/lib/data/allergens';

/** A per-allergen choice: '' = not present, else its certainty of presence. */
type Choice = '' | Presence;

/**
 * Edit one ingredient's allergen tags (Sprint 9). OPERATIONAL — kitchen and managers
 * alike open this; the change is audited server-side with the editor's identity. Each
 * of the 14 EU allergens gets an off / "may contain" / "contains" choice. Saving an
 * empty set is valid — it records "reviewed, no allergens" (never "allergen-free").
 * Built on the native `<dialog>` (no Radix), mirroring ConfirmDialog.
 */
export function IngredientAllergenDialog({
  open,
  ingredientId,
  ingredientName,
  initialTags,
  onClose,
  onSaved,
}: {
  open: boolean;
  ingredientId: string;
  ingredientName: string;
  initialTags: AllergenTag[];
  onClose: () => void;
  onSaved: (tags: AllergenTag[]) => void;
}) {
  const t = useTranslations('allergens');
  const tNames = useTranslations('allergens.labels');
  const actionError = useActionError();
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const [choices, setChoices] = React.useState<Record<AllergenSlug, Choice>>(
    {} as Record<AllergenSlug, Choice>,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Re-seed the choices from the current tags whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const next = {} as Record<AllergenSlug, Choice>;
    for (const entry of ALLERGEN_CATALOG) next[entry.slug] = '';
    for (const tag of initialTags) next[tag.allergen] = tag.presence;
    setChoices(next);
    setError(null);
  }, [open, initialTags]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  const onSave = () => {
    const allergens: AllergenTag[] = ALLERGEN_CATALOG.flatMap((entry) => {
      const choice = choices[entry.slug];
      return choice === '' || choice === undefined
        ? []
        : [{ allergen: entry.slug, presence: choice }];
    });
    setError(null);
    startTransition(async () => {
      const result = await setIngredientAllergensAction(ingredientId, { allergens });
      if (result.ok) {
        onSaved(result.data.allergens);
        onClose();
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
        if (!pending) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !pending) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-surface p-0 text-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            {t('editor.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{ingredientName}</p>
        </div>

        <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
          {t('disclaimer')}
        </p>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <div className="max-h-[50vh] overflow-y-auto pr-1">
          <ul className="flex flex-col divide-y divide-border">
            {ALLERGEN_CATALOG.map((entry) => (
              <li
                key={entry.slug}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="text-sm text-foreground">{tNames(entry.slug)}</span>
                <Select
                  aria-label={tNames(entry.slug)}
                  className="w-40"
                  value={choices[entry.slug] ?? ''}
                  disabled={pending}
                  onChange={(e) =>
                    setChoices((prev) => ({
                      ...prev,
                      [entry.slug]: e.target.value as Choice,
                    }))
                  }
                >
                  <option value="">{t('presence.none')}</option>
                  <option value="may_contain">{t('presence.may_contain')}</option>
                  <option value="contains">{t('presence.contains')}</option>
                </Select>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t('editor.cancel')}
          </Button>
          <Button type="button" onClick={onSave} disabled={pending}>
            {t('editor.save')}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
