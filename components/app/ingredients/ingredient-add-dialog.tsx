'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DIMENSIONS } from '@/lib/validation/ingredients';
import { parseMoneyToCents } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import { createIngredientAction } from '@/app/(app)/ingredients/actions';
import type { Ingredient } from '@/lib/db/schema';
import type { KitchenIngredient } from '@/lib/data/ingredients';

type Dimension = Ingredient['dimension'];

/** The price reference unit per dimension (prices are stored per kg / litre / piece). */
const PER_UNIT_SUFFIX: Record<Dimension, string> = {
  weight: '/kg',
  volume: '/l',
  count: '/pc',
};

/**
 * Manual "add ingredient" popup. Holds the ingredient's OWN identity only —
 * name, type, price. Supplier, pack size, supplier code and VAT are deliberately
 * NOT here: they live behind the row's supplier toggle, which is a different
 * question (where to buy it and for how much) with a different lifecycle.
 *
 * The catalogue is the preferred path (its entries arrive with nutrition and
 * typical allergens already filled in), so this dialog points at it; manual
 * entry is the fallback for items the catalogue does not carry.
 *
 * Built on the native `<dialog>`, mirroring IngredientCatalogDialog.
 */
export function IngredientAddDialog({
  open,
  canSeeCosts,
  onClose,
  onCreated,
  onBrowseCatalog,
}: {
  open: boolean;
  /** Manager only: offer the opening price field. Kitchen creates operationally. */
  canSeeCosts: boolean;
  onClose: () => void;
  onCreated: (ingredient: Ingredient | KitchenIngredient) => void;
  /** Close this popup and open the catalogue picker instead. */
  onBrowseCatalog: () => void;
}) {
  const t = useTranslations('ingredients');
  const tDim = useTranslations('dimensions');
  const actionError = useActionError();
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const [name, setName] = React.useState('');
  const [dimension, setDimension] = React.useState<Dimension>('weight');
  const [priceText, setPriceText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // Reset on open so the previous ingredient's values never leak into the next.
  React.useEffect(() => {
    if (!open) return;
    setName('');
    setDimension('weight');
    setPriceText('');
    setError(null);
  }, [open]);

  const onSubmit = () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createIngredientAction(
        canSeeCosts
          ? { name: trimmed, dimension, priceCents: parseMoneyToCents(priceText) }
          : { name: trimmed, dimension },
      );
      if (result.ok) {
        onCreated(result.data);
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
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-surface p-0 text-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            {t('addDialog.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('addDialog.subtitle')}</p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t('columns.name')}
          </span>
          <Input
            autoFocus
            placeholder={t('placeholders.name')}
            value={name}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t('columns.dimension')}
          </span>
          <Select
            value={dimension}
            disabled={pending}
            onChange={(e) => setDimension(e.target.value as Dimension)}
          >
            {DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {tDim(d)}
              </option>
            ))}
          </Select>
        </label>

        {canSeeCosts && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t('columns.price')}
            </span>
            <div className="flex items-center gap-1.5">
              <Input
                inputMode="decimal"
                placeholder="0.00"
                className="w-32 text-right tabular-nums"
                value={priceText}
                disabled={pending}
                onChange={(e) => setPriceText(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                {PER_UNIT_SUFFIX[dimension]}
              </span>
            </div>
          </label>
        )}

        {/* Scope note: where-to-buy-and-for-how-much is a separate flow. */}
        <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
          {t('addDialog.supplierNote')}
        </p>

        <p className="text-xs text-muted-foreground">
          {t('addDialog.catalogHint')}{' '}
          <button
            type="button"
            className="cursor-pointer font-medium text-foreground underline underline-offset-2"
            disabled={pending}
            onClick={onBrowseCatalog}
          >
            {t('catalog.open')}
          </button>
        </p>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('actions.add')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
