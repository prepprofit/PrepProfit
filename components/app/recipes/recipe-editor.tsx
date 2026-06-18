'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Check, FileText, Plus, Trash2 } from 'lucide-react';
import type { Ingredient, Recipe, RecipeFolder } from '@/lib/db/schema';
import type { RecipeLineWithIngredient } from '@/lib/data/recipes';
import {
  type MeasurementSystem,
  type Unit,
  displayUnitsFor,
  fromCanonical,
  pickDisplayUnit,
  toCanonical,
  unitLabel,
} from '@/lib/units';
import { lineCostCents, recipeCost } from '@/lib/calculations/recipeCost';
import {
  type MarginLight,
  marginPercent,
  suggestedPriceCents,
  trafficLight,
} from '@/lib/calculations/margin';
import {
  centsToAmountInput,
  formatMoney,
  parseMoneyToCents,
} from '@/lib/format/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  addRecipeIngredientAction,
  deleteRecipeAction,
  removeRecipeIngredientAction,
  updateRecipeAction,
  updateRecipeIngredientAction,
} from '@/app/(app)/recipes/actions';
import { moveRecipeToFolderAction } from '@/app/(app)/recipes/folder-actions';
import { useActionError } from '@/lib/i18n/use-action-error';

/** Target gross margin used for the suggested price. */
const TARGET_MARGIN = 70;

const LIGHT_VARIANT: Record<MarginLight, 'positive' | 'warning' | 'negative'> = {
  green: 'positive',
  yellow: 'warning',
  red: 'negative',
};

type Line = RecipeLineWithIngredient & { unit: Unit; valueText: string };

function numberToText(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function unitOptionLabel(unit: Unit): string {
  return unitLabel(unit) === '' ? 'pcs' : unitLabel(unit);
}

export function RecipeEditor({
  recipe,
  initialLines,
  ingredients,
  folders,
  currency,
  measurementSystem,
}: {
  recipe: Recipe;
  initialLines: RecipeLineWithIngredient[];
  ingredients: Ingredient[];
  folders: RecipeFolder[];
  currency: string;
  measurementSystem: MeasurementSystem;
}) {
  const t = useTranslations('recipes');
  const tDim = useTranslations('dimensions');
  const tCard = useTranslations('recipes.card');
  const tFolders = useTranslations('recipes.folders');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const makeLine = React.useCallback(
    (l: RecipeLineWithIngredient): Line => {
      const unit = pickDisplayUnit(
        l.quantity,
        l.ingredient.dimension,
        measurementSystem,
      );
      return { ...l, unit, valueText: numberToText(fromCanonical(l.quantity, unit)) };
    },
    [measurementSystem],
  );

  const [form, setForm] = React.useState({
    name: recipe.name,
    yieldPortions: String(recipe.yieldPortions),
    yieldPercentage: String(recipe.yieldPercentage),
    laborText: centsToAmountInput(recipe.laborCostCents),
    energyText: centsToAmountInput(recipe.energyCostCents),
    packagingText: centsToAmountInput(recipe.packagingCostCents),
    sellingText:
      recipe.sellingPriceCents != null
        ? centsToAmountInput(recipe.sellingPriceCents)
        : '',
    notes: recipe.notes ?? '',
  });
  const [lines, setLines] = React.useState<Line[]>(() =>
    initialLines.map(makeLine),
  );
  const [newIngredientId, setNewIngredientId] = React.useState('');
  const [newValueText, setNewValueText] = React.useState('');
  const [newUnit, setNewUnit] = React.useState<Unit>('g');
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [savedLineId, setSavedLineId] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [folderId, setFolderId] = React.useState<string | null>(recipe.folderId);
  const [pending, startTransition] = React.useTransition();

  // Briefly flag a line as "saved" after its quantity auto-saves on blur/Enter.
  const savedLineTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSavedLine = React.useCallback((lineId: string) => {
    setSavedLineId(lineId);
    if (savedLineTimer.current) clearTimeout(savedLineTimer.current);
    savedLineTimer.current = setTimeout(() => setSavedLineId(null), 1500);
  }, []);
  React.useEffect(
    () => () => {
      if (savedLineTimer.current) clearTimeout(savedLineTimer.current);
    },
    [],
  );

  // Filing the recipe is applied immediately (consistent with the list's move
  // control); on failure we revert the select to its previous value.
  const onChangeFolder = (value: string) => {
    const next = value === '' ? null : value;
    const previous = folderId;
    setFolderId(next);
    setError(null);
    startTransition(async () => {
      const result = await moveRecipeToFolderAction(recipe.id, {
        folderId: next,
      });
      if (!result.ok) {
        setFolderId(previous);
        setError(actionError(result.code));
      }
    });
  };

  const setField = (patch: Partial<typeof form>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  };

  // --- live cost & margin (recomputed from local state every render) ---
  const cost = recipeCost({
    yieldPortions: Number(form.yieldPortions) || 0,
    yieldPercentage: Number(form.yieldPercentage) || 0,
    laborCostCents: parseMoneyToCents(form.laborText),
    energyCostCents: parseMoneyToCents(form.energyText),
    packagingCostCents: parseMoneyToCents(form.packagingText),
    lines: lines.map((l) => ({
      dimension: l.ingredient.dimension,
      priceCents: l.ingredient.priceCents,
      quantity: l.quantity,
    })),
  });
  const sellingCents = parseMoneyToCents(form.sellingText);
  const hasPrice = form.sellingText.trim() !== '' && sellingCents > 0;
  const margin = marginPercent(cost.costPerPortionCents, sellingCents);
  const light = trafficLight(margin);
  const suggested = suggestedPriceCents(cost.costPerPortionCents, TARGET_MARGIN);

  const availableIngredients = ingredients.filter(
    (i) => !lines.some((l) => l.ingredientId === i.id),
  );

  // --- recipe header ---
  const onSave = () => {
    const name = form.name.trim();
    if (name === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    setError(null);
    const input = {
      name,
      yieldPortions: Math.max(1, Math.round(Number(form.yieldPortions) || 1)),
      yieldPercentage: Math.min(
        100,
        Math.max(1, Math.round(Number(form.yieldPercentage) || 100)),
      ),
      laborCostCents: parseMoneyToCents(form.laborText),
      energyCostCents: parseMoneyToCents(form.energyText),
      packagingCostCents: parseMoneyToCents(form.packagingText),
      sellingPriceCents:
        form.sellingText.trim() === ''
          ? null
          : parseMoneyToCents(form.sellingText),
      notes: form.notes.trim() === '' ? null : form.notes.trim(),
    };
    startTransition(async () => {
      const result = await updateRecipeAction(recipe.id, input);
      if (result.ok) {
        setSaved(true);
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const confirmDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteRecipeAction(recipe.id);
      if (result.ok) {
        router.push('/recipes');
      } else {
        setError(actionError(result.code));
        setConfirmOpen(false);
      }
    });
  };

  // --- lines ---
  const setLineValue = (lineId: string, valueText: string) => {
    setLines((prev) =>
      prev.map((l) =>
        l.id === lineId
          ? {
              ...l,
              valueText,
              quantity: toCanonical(Number(valueText) || 0, l.unit),
            }
          : l,
      ),
    );
  };

  const setLineUnit = (lineId: string, unit: Unit) => {
    setLines((prev) =>
      prev.map((l) =>
        l.id === lineId
          ? { ...l, unit, valueText: numberToText(fromCanonical(l.quantity, unit)) }
          : l,
      ),
    );
  };

  const persistLine = (lineId: string) => {
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    setError(null);
    startTransition(async () => {
      const result = await updateRecipeIngredientAction(recipe.id, lineId, {
        quantity: line.quantity,
      });
      if (result.ok) flashSavedLine(lineId);
      else setError(actionError(result.code));
    });
  };

  const removeLine = (lineId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await removeRecipeIngredientAction(recipe.id, lineId);
      if (result.ok) {
        setLines((prev) => prev.filter((l) => l.id !== lineId));
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const onSelectNewIngredient = (id: string) => {
    setNewIngredientId(id);
    const ing = ingredients.find((i) => i.id === id);
    if (ing) {
      const units = displayUnitsFor(ing.dimension, measurementSystem);
      setNewUnit(units[0] ?? 'g');
    }
  };

  const addLine = () => {
    const ing = ingredients.find((i) => i.id === newIngredientId);
    if (!ing) {
      setError(t('errors.pickIngredient'));
      return;
    }
    const quantity = toCanonical(Number(newValueText) || 0, newUnit);
    setError(null);
    startTransition(async () => {
      const result = await addRecipeIngredientAction(recipe.id, {
        ingredientId: ing.id,
        quantity,
        sortOrder: lines.length,
      });
      if (result.ok) {
        setLines((prev) => [
          ...prev,
          makeLine({
            id: result.data.id,
            ingredientId: ing.id,
            quantity,
            sortOrder: prev.length,
            ingredient: {
              name: ing.name,
              dimension: ing.dimension,
              priceCents: ing.priceCents,
            },
          }),
        ]);
        setNewIngredientId('');
        setNewValueText('');
      } else {
        setError(actionError(result.code));
      }
    });
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/recipes"
          className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label={t('actions.back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <Input
          aria-label={t('fields.name')}
          className="h-11 max-w-md flex-1 text-lg font-medium"
          value={form.name}
          disabled={pending}
          onChange={(e) => setField({ name: e.target.value })}
        />
        <div className="ml-auto flex items-center gap-2">
          {saved && (
            <span className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
              <Check className="size-4" />
              {t('saved')}
            </span>
          )}
          <Button asChild type="button" variant="outline">
            <Link href={`/recipes/${recipe.id}/card/print`}>
              <FileText className="size-4" />
              {tCard('action')}
            </Link>
          </Button>
          <Button type="button" onClick={onSave} disabled={pending}>
            {t('actions.save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
            aria-label={t('actions.delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Ingredients */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('ingredients.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2">{t('ingredients.name')}</th>
                    <th className="pb-2">{t('ingredients.quantity')}</th>
                    <th className="pb-2 text-right">{t('ingredients.cost')}</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td
                        colSpan={4}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        {t('ingredients.empty')}
                      </td>
                    </tr>
                  )}
                  {lines.map((line) => {
                    const units = displayUnitsFor(
                      line.ingredient.dimension,
                      measurementSystem,
                    );
                    const lineCost = Math.round(
                      lineCostCents({
                        dimension: line.ingredient.dimension,
                        priceCents: line.ingredient.priceCents,
                        quantity: line.quantity,
                      }),
                    );
                    return (
                      <tr
                        key={line.id}
                        className="border-b border-border last:border-0"
                      >
                        <td className="py-2 pr-2">
                          <span className="font-medium text-foreground">
                            {line.ingredient.name}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {tDim(line.ingredient.dimension)}
                          </span>
                        </td>
                        <td className="py-2 pr-2">
                          <div className="flex items-center gap-1.5">
                            <Input
                              aria-label={t('ingredients.quantity')}
                              inputMode="decimal"
                              className="w-24"
                              value={line.valueText}
                              disabled={pending}
                              onChange={(e) =>
                                setLineValue(line.id, e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur();
                              }}
                              onBlur={() => persistLine(line.id)}
                            />
                            <Select
                              aria-label={t('ingredients.unit')}
                              className="w-24"
                              value={line.unit}
                              disabled={pending || units.length <= 1}
                              onChange={(e) =>
                                setLineUnit(line.id, e.target.value as Unit)
                              }
                            >
                              {units.map((u) => (
                                <option key={u} value={u}>
                                  {unitOptionLabel(u)}
                                </option>
                              ))}
                            </Select>
                          </div>
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">
                          {formatMoney(lineCost, currency)}
                        </td>
                        <td className="py-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {savedLineId === line.id && (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-brand-700 dark:text-brand-300"
                                role="status"
                              >
                                <Check className="size-4" />
                                {t('saved')}
                              </span>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={t('ingredients.remove')}
                              disabled={pending}
                              onClick={() => removeLine(line.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Add line */}
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
              <Select
                aria-label={t('ingredients.add')}
                value={newIngredientId}
                disabled={pending || availableIngredients.length === 0}
                onChange={(e) => onSelectNewIngredient(e.target.value)}
              >
                <option value="">
                  {availableIngredients.length === 0
                    ? t('ingredients.allAdded')
                    : t('ingredients.select')}
                </option>
                {availableIngredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={t('ingredients.quantity')}
                inputMode="decimal"
                placeholder="0"
                className="w-24"
                value={newValueText}
                disabled={pending || newIngredientId === ''}
                onChange={(e) => setNewValueText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newIngredientId !== '') addLine();
                }}
              />
              <Select
                aria-label={t('ingredients.unit')}
                className="w-24"
                value={newUnit}
                disabled={pending || newIngredientId === ''}
                onChange={(e) => setNewUnit(e.target.value as Unit)}
              >
                {(newIngredientId
                  ? displayUnitsFor(
                      ingredients.find((i) => i.id === newIngredientId)
                        ?.dimension ?? 'weight',
                      measurementSystem,
                    )
                  : []
                ).map((u) => (
                  <option key={u} value={u}>
                    {unitOptionLabel(u)}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                onClick={addLine}
                disabled={pending || newIngredientId === ''}
              >
                <Plus className="size-4" />
                {t('ingredients.add')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Right column */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('parameters.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Field label={t('fields.folder')}>
                <Select
                  value={folderId ?? ''}
                  disabled={pending}
                  onChange={(e) => onChangeFolder(e.target.value)}
                >
                  <option value="">{tFolders('noFolder')}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('fields.yieldPortions')}>
                <Input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={form.yieldPortions}
                  disabled={pending}
                  onChange={(e) => setField({ yieldPortions: e.target.value })}
                />
              </Field>
              <Field label={t('fields.yieldPercentage')}>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  inputMode="numeric"
                  value={form.yieldPercentage}
                  disabled={pending}
                  onChange={(e) => setField({ yieldPercentage: e.target.value })}
                />
              </Field>
              <Field label={`${t('fields.labor')} · ${currency}`}>
                <Input
                  inputMode="decimal"
                  value={form.laborText}
                  disabled={pending}
                  onChange={(e) => setField({ laborText: e.target.value })}
                />
              </Field>
              <Field label={`${t('fields.energy')} · ${currency}`}>
                <Input
                  inputMode="decimal"
                  value={form.energyText}
                  disabled={pending}
                  onChange={(e) => setField({ energyText: e.target.value })}
                />
              </Field>
              <Field label={`${t('fields.packaging')} · ${currency}`}>
                <Input
                  inputMode="decimal"
                  value={form.packagingText}
                  disabled={pending}
                  onChange={(e) => setField({ packagingText: e.target.value })}
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('cost.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <Row label={t('cost.ingredients')} value={formatMoney(cost.ingredientCostCents, currency)} />
              <Row label={t('cost.hidden')} value={formatMoney(cost.hiddenCostCents, currency)} />
              <Row label={t('cost.total')} value={formatMoney(cost.totalCostCents, currency)} />
              <div className="my-1 border-t border-border" />
              <Row
                label={t('cost.perPortion')}
                value={formatMoney(cost.costPerPortionCents, currency)}
                strong
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('pricing.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <Field label={`${t('pricing.sellingPrice')} · ${currency}`}>
                <Input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form.sellingText}
                  disabled={pending}
                  onChange={(e) => setField({ sellingText: e.target.value })}
                />
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('pricing.margin')}</span>
                {hasPrice ? (
                  <Badge variant={LIGHT_VARIANT[light]}>{margin}%</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t('pricing.noPrice')}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {t('pricing.suggested', { margin: TARGET_MARGIN })}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">
                    {formatMoney(suggested, currency)}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending || suggested <= 0}
                    onClick={() =>
                      setField({ sellingText: centsToAmountInput(suggested) })
                    }
                  >
                    {t('pricing.apply')}
                  </Button>
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Notes */}
      <Card>
        <CardHeader>
          <CardTitle>{t('fields.notes')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={form.notes}
            disabled={pending}
            placeholder={t('placeholders.notes')}
            onChange={(e) => setField({ notes: e.target.value })}
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { name: recipe.name })}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          strong
            ? 'font-display text-base font-semibold text-foreground tabular-nums'
            : 'tabular-nums text-foreground'
        }
      >
        {value}
      </span>
    </div>
  );
}
