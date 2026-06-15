'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { Ingredient } from '@/lib/db/schema';
import {
  type MeasurementSystem,
  type Unit,
  displayUnitsFor,
  formatQuantity,
  fromCanonical,
  toCanonical,
  unitLabel,
} from '@/lib/units';
import { isLowStock } from '@/lib/calculations/inventory';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  recordMovementAction,
  setLowStockThresholdAction,
} from '@/app/(app)/inventory/actions';

function unitOptionLabel(unit: Unit): string {
  return unitLabel(unit) === '' ? 'pcs' : unitLabel(unit);
}

function numberToText(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function defaultUnit(
  dimension: Ingredient['dimension'],
  system: MeasurementSystem,
): Unit {
  const units = displayUnitsFor(dimension, system);
  return units[units.length - 1] ?? 'g';
}

export function InventoryPanel({
  ingredients,
  measurementSystem,
}: {
  ingredients: Ingredient[];
  measurementSystem: MeasurementSystem;
}) {
  const t = useTranslations('inventory');
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {ingredients.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2">{t('columns.ingredient')}</th>
                <th className="px-3 py-2">{t('columns.stock')}</th>
                <th className="px-3 py-2">{t('columns.adjust')}</th>
                <th className="px-3 py-2">{t('columns.threshold')}</th>
              </tr>
            </thead>
            <tbody>
              {ingredients.map((ingredient) => (
                <InventoryRow
                  key={ingredient.id}
                  ingredient={ingredient}
                  measurementSystem={measurementSystem}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function InventoryRow({
  ingredient,
  measurementSystem,
  onError,
}: {
  ingredient: Ingredient;
  measurementSystem: MeasurementSystem;
  onError: (message: string | null) => void;
}) {
  const t = useTranslations('inventory');
  const tDim = useTranslations('dimensions');

  const du = defaultUnit(ingredient.dimension, measurementSystem);
  const units = displayUnitsFor(ingredient.dimension, measurementSystem);

  const [stock, setStock] = React.useState(Number(ingredient.stockQuantity));
  const [threshold, setThreshold] = React.useState<number | null>(
    ingredient.lowStockThreshold == null
      ? null
      : Number(ingredient.lowStockThreshold),
  );
  const [adjustValue, setAdjustValue] = React.useState('');
  const [adjustUnit, setAdjustUnit] = React.useState<Unit>(du);
  const [note, setNote] = React.useState('');
  const [thresholdValue, setThresholdValue] = React.useState(
    threshold == null ? '' : numberToText(fromCanonical(threshold, du)),
  );
  const [thresholdUnit, setThresholdUnit] = React.useState<Unit>(du);
  const [pending, startTransition] = React.useTransition();

  const low = isLowStock(stock, threshold);

  const move = (direction: 1 | -1) => {
    const magnitude = toCanonical(Number(adjustValue) || 0, adjustUnit);
    if (magnitude <= 0) {
      onError(t('errors.quantity'));
      return;
    }
    onError(null);
    startTransition(async () => {
      const result = await recordMovementAction({
        ingredientId: ingredient.id,
        deltaCanonical: direction * magnitude,
        note,
      });
      if (result.ok) {
        setStock(result.data.stockQuantity);
        setAdjustValue('');
        setNote('');
      } else {
        onError(result.error);
      }
    });
  };

  const saveThreshold = () => {
    const trimmed = thresholdValue.trim();
    const canonical =
      trimmed === '' ? null : toCanonical(Number(trimmed) || 0, thresholdUnit);
    onError(null);
    startTransition(async () => {
      const result = await setLowStockThresholdAction(ingredient.id, {
        lowStockThreshold: canonical,
      });
      if (result.ok) {
        setThreshold(result.data.lowStockThreshold);
      } else {
        onError(result.error);
      }
    });
  };

  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-3 py-3">
        <span className="font-medium text-foreground">{ingredient.name}</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {tDim(ingredient.dimension)}
        </span>
      </td>

      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="tabular-nums text-foreground">
            {formatQuantity(stock, ingredient.dimension, measurementSystem)}
          </span>
          {low && <Badge variant="negative">{t('low')}</Badge>}
        </div>
      </td>

      <td className="px-3 py-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Input
              aria-label={t('columns.adjust')}
              inputMode="decimal"
              placeholder="0"
              className="w-20"
              value={adjustValue}
              disabled={pending}
              onChange={(e) => setAdjustValue(e.target.value)}
            />
            <Select
              aria-label={t('unit')}
              className="w-20"
              value={adjustUnit}
              disabled={pending || units.length <= 1}
              onChange={(e) => setAdjustUnit(e.target.value as Unit)}
            >
              {units.map((u) => (
                <option key={u} value={u}>
                  {unitOptionLabel(u)}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => move(1)}
            >
              <ArrowUp className="size-4" />
              {t('in')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => move(-1)}
            >
              <ArrowDown className="size-4" />
              {t('out')}
            </Button>
          </div>
          <Input
            aria-label={t('note')}
            placeholder={t('notePlaceholder')}
            className="h-8 max-w-xs text-xs"
            value={note}
            disabled={pending}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </td>

      <td className="px-3 py-3">
        <div className="flex items-center gap-1.5">
          <Input
            aria-label={t('columns.threshold')}
            inputMode="decimal"
            placeholder={t('noThreshold')}
            className="w-20"
            value={thresholdValue}
            disabled={pending}
            onChange={(e) => setThresholdValue(e.target.value)}
          />
          <Select
            aria-label={t('unit')}
            className="w-20"
            value={thresholdUnit}
            disabled={pending || units.length <= 1}
            onChange={(e) => setThresholdUnit(e.target.value as Unit)}
          >
            {units.map((u) => (
              <option key={u} value={u}>
                {unitOptionLabel(u)}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={saveThreshold}
          >
            {t('setThreshold')}
          </Button>
        </div>
      </td>
    </tr>
  );
}
