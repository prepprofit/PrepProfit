'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useActionError } from '@/lib/i18n/use-action-error';
import { centsToAmountInput, formatMoney, parseMoneyToCents } from '@/lib/format/money';
import { dimensionOf, unitLabel, type Dimension, type Unit } from '@/lib/units';
import { PACK_UNITS } from '@/lib/validation/suppliers';
import {
  acceptPendingCostAction,
  clearIngredientSupplierAction,
  setIngredientSupplierAction,
} from '@/app/(app)/ingredients/actions';
import type { DefaultSupplierSummary } from '@/lib/data/ingredient-suppliers';

/**
 * Set the DEFAULT supplier + purchase pack on one ingredient (Sprint 7),
 * MANAGER-ONLY (the grid only mounts it for cost-seeing managers; the server is
 * the real gate). Type-or-pick a supplier (datalist over existing names), an
 * optional pack (size + unit + price). A pack price raises a PENDING cost the
 * manager then Accepts here. Native `<dialog>`, mirroring the allergen editor.
 */
export function IngredientSupplierDialog({
  open,
  ingredientId,
  ingredientName,
  dimension,
  currency,
  supplierNames,
  initialLink,
  pendingPriceCents,
  onClose,
  onSaved,
  onCleared,
  onAccepted,
}: {
  open: boolean;
  ingredientId: string;
  ingredientName: string;
  dimension: Dimension;
  currency: string;
  /** Existing supplier names for the datalist (manager's active suppliers). */
  supplierNames: string[];
  initialLink: DefaultSupplierSummary | null;
  pendingPriceCents: number | null;
  onClose: () => void;
  onSaved: (summary: DefaultSupplierSummary) => void;
  onCleared: () => void;
  onAccepted: (priceCents: number) => void;
}) {
  const t = useTranslations('suppliers.ingredientEditor');
  const actionError = useActionError();
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const listId = React.useId();

  const [supplierName, setSupplierName] = React.useState('');
  const [packSize, setPackSize] = React.useState('');
  const [packUnit, setPackUnit] = React.useState<Unit | ''>('');
  const [packPriceText, setPackPriceText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Pack units valid for this ingredient's dimension (PACK_UNIT_MISMATCH otherwise).
  const unitOptions = React.useMemo(
    () => PACK_UNITS.filter((u) => dimensionOf(u) === dimension),
    [dimension],
  );

  // Re-seed from the current link whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    setSupplierName(initialLink?.supplierName ?? '');
    setPackSize(initialLink?.packSize != null ? String(initialLink.packSize) : '');
    setPackUnit((initialLink?.packUnit as Unit | null) ?? '');
    setPackPriceText(
      initialLink?.packPriceCents != null
        ? centsToAmountInput(initialLink.packPriceCents)
        : '',
    );
    setError(null);
  }, [open, initialLink]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  const onSave = () => {
    const name = supplierName.trim();
    if (name === '') {
      setError(actionError('INVALID_INPUT'));
      return;
    }
    const sizeNum = packSize.trim() === '' ? undefined : Number(packSize);
    const hasSize = sizeNum !== undefined && Number.isFinite(sizeNum) && sizeNum > 0;
    const unit = packUnit === '' ? undefined : packUnit;
    const priceCents =
      packPriceText.trim() === '' ? undefined : parseMoneyToCents(packPriceText);

    const input = {
      supplierName: name,
      ...(hasSize ? { packSize: sizeNum } : {}),
      ...(unit ? { packUnit: unit } : {}),
      ...(priceCents !== undefined ? { packPriceCents: priceCents } : {}),
    };

    setError(null);
    startTransition(async () => {
      const result = await setIngredientSupplierAction(ingredientId, input);
      if (result.ok) {
        onSaved({
          supplierName: name,
          packSize: hasSize ? sizeNum : null,
          packUnit: unit ?? null,
          packPriceCents: priceCents ?? null,
        });
        onClose();
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const onClear = () => {
    setError(null);
    startTransition(async () => {
      const result = await clearIngredientSupplierAction(ingredientId);
      if (result.ok) {
        onCleared();
        onClose();
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const onAccept = () => {
    setError(null);
    startTransition(async () => {
      const result = await acceptPendingCostAction(ingredientId);
      if (result.ok) {
        onAccepted(result.data.priceCents);
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
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            {t('heading')}
          </h2>
          <p className="text-sm text-muted-foreground">{ingredientName}</p>
        </div>

        {pendingPriceCents != null && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="text-amber-800 dark:text-amber-200">
              {t('pendingHint', { amount: formatMoney(pendingPriceCents, currency) })}
            </p>
            <Button
              type="button"
              size="sm"
              className="self-start"
              onClick={onAccept}
              disabled={pending}
            >
              {t('accept')}
            </Button>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${titleId}-name`}>{t('supplierName')}</Label>
          <Input
            id={`${titleId}-name`}
            list={listId}
            placeholder={t('supplierPlaceholder')}
            value={supplierName}
            disabled={pending}
            onChange={(e) => setSupplierName(e.target.value)}
          />
          <datalist id={listId}>
            {supplierNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${titleId}-size`}>{t('packSize')}</Label>
            <Input
              id={`${titleId}-size`}
              inputMode="decimal"
              placeholder="0"
              value={packSize}
              disabled={pending}
              onChange={(e) => setPackSize(e.target.value)}
            />
          </div>
          <div className="flex w-28 flex-col gap-1.5">
            <Label htmlFor={`${titleId}-unit`}>{t('packUnit')}</Label>
            <Select
              id={`${titleId}-unit`}
              value={packUnit}
              disabled={pending}
              onChange={(e) => setPackUnit(e.target.value as Unit | '')}
            >
              <option value="">—</option>
              {unitOptions.map((u) => (
                <option key={u} value={u}>
                  {unitLabel(u) || u}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${titleId}-price`}>
            {t('packPrice')} · {currency}
          </Label>
          <Input
            id={`${titleId}-price`}
            inputMode="decimal"
            placeholder="0.00"
            value={packPriceText}
            disabled={pending}
            onChange={(e) => setPackPriceText(e.target.value)}
          />
        </div>

        <div className="mt-1 flex items-center justify-between gap-2">
          {initialLink ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onClear}
              disabled={pending}
            >
              {t('clear')}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={pending}
            >
              {t('cancel')}
            </Button>
            <Button type="button" onClick={onSave} disabled={pending}>
              {t('save')}
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
