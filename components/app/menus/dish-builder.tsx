'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, Check, Plus, Search, Trash2, X } from 'lucide-react';
import {
  compositionCost,
  DISH_RECIPE_UNITS,
  dishPricing,
  ingredientCanonicalQuantity,
  ingredientLineKey,
  ingredientUnitsFor,
  priceExclVat,
  priceForFoodCost,
  priceForMargin,
  recipeLineKey,
  type DishIngredientUnit,
  type DishRecipeUnit,
} from '@/lib/calculations/dish';
import type {
  DishIngredientOption,
  DishRecipeOption,
  KitchenDishIngredientLine,
  KitchenDishRecipeLine,
} from '@/lib/data/menus';
import { centsToAmountInput, formatMoney, parseMoneyToCents } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createDishAction,
  deleteMenuAction,
  markDishOpenedAction,
  updateDishAction,
} from '@/app/(app)/menus/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatPercentBps, marginVariant, numberToField } from './dish-format';

export type DishBuilderInitial = {
  id: string | null;
  name: string;
  folderId: string | null;
  portions: number;
  sellingPriceCents: number | null;
  vatRateBps: number | null;
  notes: string | null;
  recipeLines: KitchenDishRecipeLine[];
  ingredientLines: KitchenDishIngredientLine[];
};

type RecipeLineState = { recipeId: string; name: string; quantity: string; unit: DishRecipeUnit };
type IngredientLineState = {
  ingredientId: string;
  name: string;
  quantity: string;
  unit: DishIngredientUnit;
};
type PricingField = 'excl' | 'incl' | 'margin' | 'foodCost';

function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Dish Builder (Menu redesign). Build a dish from recipes (portion / g / kg) and
 * direct ingredients; cost, gross profit, margin and food cost update on every
 * keystroke through the SAME `compositionCost` the server and every insight module
 * use. Pricing is bidirectional: type a price (excl. or incl. VAT), a target margin
 * or a food-cost % and the others follow. Only Save talks to the server.
 */
export function DishBuilder({
  initial,
  folders,
  recipeOptions,
  ingredientOptions,
  currency,
  defaultVatBps,
}: {
  initial: DishBuilderInitial;
  folders: { id: string; name: string }[];
  recipeOptions: DishRecipeOption[];
  ingredientOptions: DishIngredientOption[];
  currency: string;
  /** The org's sales VAT rate; used when the dish has no own rate. */
  defaultVatBps: number | null;
}) {
  const t = useTranslations('menus.builder');
  const tUnits = useTranslations('menus.units');
  const actionError = useActionError();
  const router = useRouter();
  const money = React.useCallback((cents: number) => formatMoney(cents, currency), [currency]);

  const isNew = initial.id === null;
  const recipeById = React.useMemo(() => new Map(recipeOptions.map((r) => [r.id, r])), [recipeOptions]);
  const ingredientById = React.useMemo(
    () => new Map(ingredientOptions.map((i) => [i.id, i])),
    [ingredientOptions],
  );

  // ── Editable state ─────────────────────────────────────────────────────────
  const [name, setName] = React.useState(initial.name);
  const [folderId, setFolderId] = React.useState(initial.folderId);
  const [portions, setPortions] = React.useState(String(initial.portions));
  const [notes, setNotes] = React.useState(initial.notes ?? '');
  const [priceExclCents, setPriceExclCents] = React.useState(initial.sellingPriceCents);
  const [vatText, setVatText] = React.useState(
    initial.vatRateBps !== null ? numberToField(initial.vatRateBps / 100) : '',
  );
  const [draft, setDraft] = React.useState<{ field: PricingField; text: string } | null>(null);
  const [recipeLines, setRecipeLines] = React.useState<RecipeLineState[]>(() =>
    initial.recipeLines.map((l) => ({
      recipeId: l.recipeId,
      name: l.recipeName,
      quantity: numberToField(l.quantity),
      unit: l.unit,
    })),
  );
  const [ingredientLines, setIngredientLines] = React.useState<IngredientLineState[]>(() =>
    initial.ingredientLines.map((l) => ({
      ingredientId: l.ingredientId,
      name: l.ingredientName,
      quantity: numberToField(l.quantity),
      unit: l.unit,
    })),
  );

  React.useEffect(() => {
    if (initial.id) void markDishOpenedAction(initial.id);
  }, [initial.id]);

  // ── Derived: cost ──────────────────────────────────────────────────────────
  const portionsValue = parseNumber(portions);
  const portionsInt =
    portionsValue !== null && Number.isInteger(portionsValue) && portionsValue >= 1 && portionsValue <= 100_000
      ? portionsValue
      : null;

  const cost = compositionCost(
    {
      portions: portionsInt ?? 0,
      recipeLines: recipeLines.map((l) => ({
        recipeId: l.recipeId,
        quantity: parseNumber(l.quantity) ?? 0,
        unit: l.unit,
      })),
      ingredientLines: ingredientLines.map((l) => ({
        ingredientId: l.ingredientId,
        quantity: ingredientCanonicalQuantity(parseNumber(l.quantity) ?? 0, l.unit),
        unit: l.unit,
      })),
    },
    {
      recipeCostPerPortion: (id) => recipeById.get(id)?.costPerPortionCents ?? null,
      recipeYield: (id) => recipeById.get(id) ?? null,
      ingredient: (id) => ingredientById.get(id) ?? null,
    },
  );
  const lineCost = new Map(cost.lineCosts.map((l) => [l.key, l.costCents]));
  const knownTotal = cost.lineCosts.reduce((sum, l) => sum + (l.costCents ?? 0), 0);

  // ── Derived: pricing ───────────────────────────────────────────────────────
  const vatValue = parseNumber(vatText);
  const vatValid = vatText.trim() === '' || (vatValue !== null && vatValue >= 0 && vatValue <= 100);
  const vatBps = vatText.trim() === '' || vatValue === null ? (defaultVatBps ?? 0) : Math.round(vatValue * 100);
  const pricing = dishPricing(cost.costPerPortionCents, priceExclCents, vatBps);
  const costKnown = cost.costPerPortionCents !== null && cost.costPerPortionCents > 0;

  function pricingText(field: PricingField): string {
    if (draft?.field === field) return draft.text;
    switch (field) {
      case 'excl':
        return pricing.priceExclCents !== null ? centsToAmountInput(pricing.priceExclCents) : '';
      case 'incl':
        return pricing.priceInclCents !== null ? centsToAmountInput(pricing.priceInclCents) : '';
      case 'margin':
        return pricing.marginBps !== null ? numberToField(pricing.marginBps / 100) : '';
      case 'foodCost':
        return pricing.foodCostBps !== null ? numberToField(pricing.foodCostBps / 100) : '';
    }
  }

  function onPricingChange(field: PricingField, text: string) {
    setDraft({ field, text });
    const empty = text.trim() === '';
    if (field === 'excl') {
      setPriceExclCents(empty ? null : parseMoneyToCents(text));
    } else if (field === 'incl') {
      setPriceExclCents(empty ? null : priceExclVat(parseMoneyToCents(text), vatBps));
    } else {
      const pct = parseNumber(text);
      if (pct === null) return;
      const price =
        field === 'margin'
          ? priceForMargin(cost.costPerPortionCents, Math.round(pct * 100))
          : priceForFoodCost(cost.costPerPortionCents, Math.round(pct * 100));
      if (price !== null) setPriceExclCents(price);
    }
  }

  // ── Lines ──────────────────────────────────────────────────────────────────
  function addRecipe(option: DishRecipeOption) {
    setRecipeLines((prev) => [
      ...prev,
      {
        recipeId: option.id,
        name: option.name,
        quantity: option.yieldWeightGrams ? '100' : '1',
        unit: option.yieldWeightGrams ? 'g' : 'portion',
      },
    ]);
  }
  function addIngredient(option: DishIngredientOption) {
    const unit = ingredientUnitsFor(option.dimension)[0] ?? 'piece';
    setIngredientLines((prev) => [
      ...prev,
      { ingredientId: option.id, name: option.name, quantity: unit === 'piece' ? '1' : '10', unit },
    ]);
  }

  // ── Save / dirty ───────────────────────────────────────────────────────────
  const unavailableRecipes = recipeLines.filter((l) => !recipeById.has(l.recipeId));
  const unavailableIngredients = ingredientLines.filter((l) => !ingredientById.has(l.ingredientId));
  const invalidQuantity = [...recipeLines, ...ingredientLines].some((l) => {
    const q = parseNumber(l.quantity);
    return q === null || q <= 0;
  });

  const payload = {
    name: name.trim(),
    folderId,
    portions: portionsInt ?? 0,
    sellingPriceCents: priceExclCents,
    vatRateBps: vatText.trim() === '' || vatValue === null ? null : Math.round(vatValue * 100),
    notes: notes.trim() === '' ? null : notes.trim(),
    recipeLines: recipeLines.map((l) => ({
      recipeId: l.recipeId,
      quantity: parseNumber(l.quantity) ?? 0,
      unit: l.unit,
    })),
    ingredientLines: ingredientLines.map((l) => ({
      ingredientId: l.ingredientId,
      quantity: parseNumber(l.quantity) ?? 0,
      unit: l.unit,
    })),
  };
  const payloadKey = JSON.stringify(payload);
  const [savedKey, setSavedKey] = React.useState(() => (isNew ? '' : payloadKey));
  const dirty = payloadKey !== savedKey;

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const problems = [
    payload.name === '' && t('problems.name'),
    portionsInt === null && t('problems.portions'),
    !vatValid && t('problems.vat'),
    invalidQuantity && t('problems.quantity'),
    (unavailableRecipes.length > 0 || unavailableIngredients.length > 0) && t('problems.unavailable'),
  ].filter((p): p is string => typeof p === 'string');
  const canSave = problems.length === 0;

  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  function save() {
    if (!canSave) return;
    setError(null);
    setJustSaved(false);
    startTransition(async () => {
      if (isNew) {
        const result = await createDishAction(payload);
        if (!result.ok) return setError(actionError(result.code));
        setSavedKey(payloadKey);
        router.replace(`/menus/${result.data.id}`);
        return;
      }
      const result = await updateDishAction(initial.id as string, payload);
      if (!result.ok) return setError(actionError(result.code));
      setSavedKey(payloadKey);
      setJustSaved(true);
      router.refresh();
    });
  }

  function remove() {
    if (!initial.id) return;
    startTransition(async () => {
      const result = await deleteMenuAction(initial.id as string);
      if (!result.ok) {
        setConfirmDelete(false);
        return setError(actionError(result.code));
      }
      setSavedKey(payloadKey);
      router.push(folderId ? `/menus/folders/${folderId}` : '/menus/folders/unfiled');
    });
  }

  const backHref = initial.folderId ? `/menus/folders/${initial.folderId}` : isNew ? '/menus' : '/menus/folders/unfiled';
  const marginText = pricing.marginBps !== null ? formatPercentBps(pricing.marginBps) : '—';

  const saveButton = (
    <Button type="submit" disabled={!canSave || pending || (!dirty && !isNew)} className="w-full sm:w-auto">
      {pending ? t('saving') : isNew ? t('create') : t('save')}
    </Button>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="mx-auto flex w-full max-w-6xl flex-col gap-5 pb-24 lg:pb-0"
    >
      {/* Header */}
      <div className="flex flex-col gap-3">
        <Link
          href={backHref}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t('back')}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="min-w-0 truncate font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {name.trim() || t('untitled')}
          </h2>
          <div className="hidden items-center gap-2 lg:flex">
            {justSaved && !dirty && (
              <span role="status" className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
                <Check className="size-4" /> {t('saved')}
              </span>
            )}
            {dirty && !isNew && <span className="text-sm text-muted-foreground">{t('unsaved')}</span>}
            {!isNew && (
              <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                {t('delete')}
              </Button>
            )}
            {saveButton}
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
            {error}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* Details */}
          <Card>
            <CardContent className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_8rem]">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dish-name">{t('fields.name')}</Label>
                <Input
                  id="dish-name"
                  value={name}
                  maxLength={200}
                  autoFocus={isNew}
                  placeholder={t('fields.namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dish-folder">{t('fields.folder')}</Label>
                <Select
                  id="dish-folder"
                  value={folderId ?? ''}
                  onChange={(e) => setFolderId(e.target.value === '' ? null : e.target.value)}
                >
                  <option value="">{t('fields.unfiled')}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dish-portions">{t('fields.portions')}</Label>
                <Input
                  id="dish-portions"
                  inputMode="numeric"
                  value={portions}
                  aria-invalid={portionsInt === null}
                  onChange={(e) => setPortions(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          {/* Pricing */}
          <Card>
            <CardHeader>
              <CardTitle>{t('pricing.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                <PricingInput
                  id="price-excl"
                  label={t('pricing.priceExcl')}
                  value={pricingText('excl')}
                  onChange={(v) => onPricingChange('excl', v)}
                  onBlur={() => setDraft(null)}
                  placeholder="0.00"
                />
                <PricingInput
                  id="price-incl"
                  label={t('pricing.priceIncl')}
                  value={pricingText('incl')}
                  onChange={(v) => onPricingChange('incl', v)}
                  onBlur={() => setDraft(null)}
                  placeholder="0.00"
                />
                <PricingInput
                  id="vat"
                  label={t('pricing.vat')}
                  value={vatText}
                  invalid={!vatValid}
                  onChange={(v) => setVatText(v)}
                  placeholder={defaultVatBps !== null ? numberToField(defaultVatBps / 100) : '0'}
                  hint={vatText.trim() === '' ? t('pricing.vatDefault') : undefined}
                  suffix="%"
                />
                <PricingInput
                  id="margin"
                  label={t('pricing.margin')}
                  value={pricingText('margin')}
                  onChange={(v) => onPricingChange('margin', v)}
                  onBlur={() => setDraft(null)}
                  disabled={!costKnown}
                  suffix="%"
                />
                <PricingInput
                  id="food-cost"
                  label={t('pricing.foodCost')}
                  value={pricingText('foodCost')}
                  onChange={(v) => onPricingChange('foodCost', v)}
                  onBlur={() => setDraft(null)}
                  disabled={!costKnown}
                  suffix="%"
                />
                <ReadOnlyValue
                  label={t('pricing.grossProfit')}
                  value={pricing.grossProfitCents !== null ? money(pricing.grossProfitCents) : '—'}
                  negative={pricing.grossProfitCents !== null && pricing.grossProfitCents < 0}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {costKnown ? t('pricing.hint') : t('pricing.hintNoCost')}
              </p>
            </CardContent>
          </Card>

          {/* Recipes */}
          <Card>
            <CardHeader>
              <CardTitle>{t('recipes.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {recipeLines.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('recipes.empty')}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {recipeLines.map((line, index) => {
                    const option = recipeById.get(line.recipeId);
                    const contribution = lineCost.get(recipeLineKey(line.recipeId)) ?? null;
                    const unitCost = option
                      ? option.costPerKgCents !== null
                        ? t('recipes.perKg', { amount: money(option.costPerKgCents) })
                        : option.costPerPortionCents !== null
                          ? t('recipes.perPortion', { amount: money(option.costPerPortionCents) })
                          : null
                      : null;
                    // g/kg need the recipe's batch weight; keep the saved unit listed so the select never lies.
                    const units = DISH_RECIPE_UNITS.filter(
                      (u) => u === 'portion' || option?.yieldWeightGrams || u === line.unit,
                    );
                    const q = parseNumber(line.quantity);
                    const needsWeight = option && line.unit !== 'portion' && !option.yieldWeightGrams;
                    return (
                      <ComponentRow
                        key={line.recipeId}
                        name={line.name}
                        meta={
                          !option ? (
                            <Badge variant="negative">{t('unavailable')}</Badge>
                          ) : unitCost ? (
                            <span>{unitCost}</span>
                          ) : (
                            <Badge variant="warning">{t('needsPricing')}</Badge>
                          )
                        }
                        warning={needsWeight ? t('recipes.needsWeight') : undefined}
                        quantity={line.quantity}
                        quantityInvalid={q === null || q <= 0}
                        onQuantity={(value) =>
                          setRecipeLines((prev) => prev.map((l, i) => (i === index ? { ...l, quantity: value } : l)))
                        }
                        unit={line.unit}
                        units={units.map((u) => ({ value: u, label: tUnits(u) }))}
                        onUnit={(value) =>
                          setRecipeLines((prev) =>
                            prev.map((l, i) => (i === index ? { ...l, unit: value as DishRecipeUnit } : l)),
                          )
                        }
                        contribution={contribution !== null ? money(contribution) : '—'}
                        share={contribution !== null && knownTotal > 0 ? contribution / knownTotal : null}
                        removeLabel={t('remove')}
                        onRemove={() => setRecipeLines((prev) => prev.filter((_, i) => i !== index))}
                        quantityLabel={t('quantity')}
                        unitLabel={t('unit')}
                      />
                    );
                  })}
                </ul>
              )}
              <ComponentPicker
                placeholder={t('recipes.add')}
                emptyLabel={t('noMatches')}
                options={recipeOptions
                  .filter((r) => !recipeLines.some((l) => l.recipeId === r.id))
                  .map((r) => ({
                    id: r.id,
                    name: r.name,
                    hint:
                      r.costPerKgCents !== null
                        ? t('recipes.perKg', { amount: money(r.costPerKgCents) })
                        : r.costPerPortionCents !== null
                          ? t('recipes.perPortion', { amount: money(r.costPerPortionCents) })
                          : t('needsPricing'),
                  }))}
                onPick={(id) => {
                  const option = recipeById.get(id);
                  if (option) addRecipe(option);
                }}
              />
            </CardContent>
          </Card>

          {/* Ingredients */}
          <Card>
            <CardHeader>
              <CardTitle>{t('ingredients.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {ingredientLines.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('ingredients.empty')}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {ingredientLines.map((line, index) => {
                    const option = ingredientById.get(line.ingredientId);
                    const contribution = lineCost.get(ingredientLineKey(line.ingredientId)) ?? null;
                    const q = parseNumber(line.quantity);
                    return (
                      <ComponentRow
                        key={line.ingredientId}
                        name={line.name}
                        meta={
                          !option ? (
                            <Badge variant="negative">{t('unavailable')}</Badge>
                          ) : option.needsPricing ? (
                            <Badge variant="warning">{t('needsPricing')}</Badge>
                          ) : (
                            <span>
                              {t(`ingredients.per.${option.dimension}`, { amount: money(option.priceCents) })}
                            </span>
                          )
                        }
                        quantity={line.quantity}
                        quantityInvalid={q === null || q <= 0}
                        onQuantity={(value) =>
                          setIngredientLines((prev) =>
                            prev.map((l, i) => (i === index ? { ...l, quantity: value } : l)),
                          )
                        }
                        unit={line.unit}
                        units={(option ? ingredientUnitsFor(option.dimension) : [line.unit]).map((u) => ({
                          value: u,
                          label: tUnits(u),
                        }))}
                        onUnit={(value) =>
                          setIngredientLines((prev) =>
                            prev.map((l, i) => (i === index ? { ...l, unit: value as DishIngredientUnit } : l)),
                          )
                        }
                        contribution={contribution !== null ? money(contribution) : '—'}
                        share={contribution !== null && knownTotal > 0 ? contribution / knownTotal : null}
                        removeLabel={t('remove')}
                        onRemove={() => setIngredientLines((prev) => prev.filter((_, i) => i !== index))}
                        quantityLabel={t('quantity')}
                        unitLabel={t('unit')}
                      />
                    );
                  })}
                </ul>
              )}
              <ComponentPicker
                placeholder={t('ingredients.add')}
                emptyLabel={t('noMatches')}
                options={ingredientOptions
                  .filter((i) => !ingredientLines.some((l) => l.ingredientId === i.id))
                  .map((i) => ({
                    id: i.id,
                    name: i.name,
                    hint: i.needsPricing
                      ? t('needsPricing')
                      : t(`ingredients.per.${i.dimension}`, { amount: money(i.priceCents) }),
                  }))}
                onPick={(id) => {
                  const option = ingredientById.get(id);
                  if (option) addIngredient(option);
                }}
              />
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardContent className="flex flex-col gap-1.5 pt-6">
              <Label htmlFor="dish-notes">{t('fields.notes')}</Label>
              <Textarea
                id="dish-notes"
                value={notes}
                maxLength={1000}
                placeholder={t('fields.notesPlaceholder')}
                onChange={(e) => setNotes(e.target.value)}
              />
            </CardContent>
          </Card>
        </div>

        {/* Live financial summary */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start" aria-label={t('summary.title')}>
          <Card>
            <CardContent className="flex flex-col gap-4 pt-6">
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-muted-foreground">{t('summary.margin')}</span>
                <Badge variant={marginVariant(pricing.marginBps)}>{marginText}</Badge>
              </div>
              <p className="font-display text-4xl font-semibold tabular-nums tracking-tight text-foreground">
                {pricing.grossProfitCents !== null ? money(pricing.grossProfitCents) : '—'}
              </p>
              <p className="-mt-3 text-xs text-muted-foreground">{t('summary.profitPerPortion')}</p>

              <dl className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
                <SummaryRow
                  label={t('summary.totalCost')}
                  value={cost.totalCostCents !== null ? money(cost.totalCostCents) : '—'}
                />
                <SummaryRow
                  label={t('summary.costPerPortion')}
                  value={cost.costPerPortionCents !== null ? money(cost.costPerPortionCents) : '—'}
                />
                <SummaryRow
                  label={t('summary.sellingPrice')}
                  value={pricing.priceExclCents !== null ? money(pricing.priceExclCents) : '—'}
                  sub={
                    pricing.priceInclCents !== null
                      ? t('summary.inclVat', { amount: money(pricing.priceInclCents) })
                      : undefined
                  }
                />
                <SummaryRow
                  label={t('summary.grossProfit')}
                  value={pricing.grossProfitCents !== null ? money(pricing.grossProfitCents) : '—'}
                />
                <SummaryRow label={t('summary.grossMargin')} value={marginText} />
                <SummaryRow
                  label={t('summary.foodCost')}
                  value={pricing.foodCostBps !== null ? formatPercentBps(pricing.foodCostBps) : '—'}
                />
              </dl>

              {!cost.complete && (recipeLines.length > 0 || ingredientLines.length > 0) && (
                <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {portionsInt === null
                    ? t('summary.portionsMissing')
                    : t('summary.incomplete', { count: cost.incompleteKeys.length })}
                </p>
              )}

              {cost.lineCosts.length > 0 && knownTotal > 0 && (
                <div className="flex flex-col gap-2 border-t border-border pt-4">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t('summary.breakdown')}
                  </span>
                  <ul className="flex flex-col gap-2">
                    {[...recipeLines.map((l) => ({ key: recipeLineKey(l.recipeId), name: l.name })),
                      ...ingredientLines.map((l) => ({ key: ingredientLineKey(l.ingredientId), name: l.name }))]
                      .map((l) => ({ ...l, cents: lineCost.get(l.key) ?? null }))
                      .filter((l): l is { key: string; name: string; cents: number } => l.cents !== null)
                      .sort((a, b) => b.cents - a.cents)
                      .slice(0, 6)
                      .map((l) => (
                        <li key={l.key} className="flex flex-col gap-1">
                          <div className="flex justify-between gap-2 text-xs">
                            <span className="truncate text-foreground">{l.name}</span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {Math.round((l.cents / knownTotal) * 100)}%
                            </span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                            <div
                              className="h-full rounded-full bg-accent-500"
                              style={{ width: `${Math.max(2, (l.cents / knownTotal) * 100)}%` }}
                            />
                          </div>
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              {!canSave && (recipeLines.length > 0 || name !== '' || !isNew) && (
                <ul className="flex flex-col gap-1 text-xs text-red-700 dark:text-red-300">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <div className="hidden lg:block">{saveButton}</div>
            </CardContent>
          </Card>
        </aside>
      </div>

      {/* Mobile: the summary stays in reach while editing. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col text-xs">
            <span className="truncate text-muted-foreground">
              {t('summary.costPerPortion')}:{' '}
              <span className="tabular-nums text-foreground">
                {cost.costPerPortionCents !== null ? money(cost.costPerPortionCents) : '—'}
              </span>
            </span>
            <span className="truncate font-medium text-foreground">
              {pricing.priceExclCents !== null ? money(pricing.priceExclCents) : '—'} · {marginText}
            </span>
          </div>
          {!isNew && (
            <Button type="button" variant="ghost" size="sm" aria-label={t('delete')} onClick={() => setConfirmDelete(true)}>
              <Trash2 />
            </Button>
          )}
          <div className="shrink-0">{saveButton}</div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t('deleteTitle')}
        description={t('deleteBody', { name: name.trim() || t('untitled') })}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        destructive
        pending={pending}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </form>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function PricingInput({
  id,
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  disabled,
  invalid,
  hint,
  suffix,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  hint?: string;
  suffix?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="truncate">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={cn('tabular-nums', suffix && 'pr-8')}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function ReadOnlyValue({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="truncate text-sm font-medium text-foreground">{label}</span>
      <span
        className={cn(
          'flex h-10 items-center text-sm font-medium tabular-nums',
          negative ? 'text-red-700 dark:text-red-300' : 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SummaryRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex flex-col items-end">
        <span className="font-medium tabular-nums text-foreground">{value}</span>
        {sub && <span className="text-xs tabular-nums text-muted-foreground">{sub}</span>}
      </dd>
    </div>
  );
}

function ComponentRow({
  name,
  meta,
  warning,
  quantity,
  quantityInvalid,
  onQuantity,
  unit,
  units,
  onUnit,
  contribution,
  share,
  removeLabel,
  onRemove,
  quantityLabel,
  unitLabel,
}: {
  name: string;
  meta: React.ReactNode;
  warning?: string;
  quantity: string;
  quantityInvalid: boolean;
  onQuantity: (value: string) => void;
  unit: string;
  units: { value: string; label: string }[];
  onUnit: (value: string) => void;
  contribution: string;
  share: number | null;
  removeLabel: string;
  onRemove: () => void;
  quantityLabel: string;
  unitLabel: string;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <div className="flex min-w-0 basis-full flex-col gap-0.5 sm:basis-0 sm:flex-1">
        <span className="truncate font-medium text-foreground">{name}</span>
        <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">{meta}</span>
        {warning && <span className="text-xs text-amber-700 dark:text-amber-300">{warning}</span>}
      </div>
      <Input
        inputMode="decimal"
        value={quantity}
        aria-label={`${quantityLabel} — ${name}`}
        aria-invalid={quantityInvalid}
        onChange={(e) => onQuantity(e.target.value)}
        className="h-9 w-20 text-right tabular-nums"
      />
      <div className="w-28">
        <Select
          value={unit}
          aria-label={`${unitLabel} — ${name}`}
          onChange={(e) => onUnit(e.target.value)}
          className="h-9"
        >
          {units.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="ml-auto flex w-24 flex-col items-end">
        <span className="text-sm font-medium tabular-nums text-foreground">{contribution}</span>
        {share !== null && (
          <span className="text-xs tabular-nums text-muted-foreground">{Math.round(share * 100)}%</span>
        )}
      </div>
      <Button type="button" variant="ghost" size="sm" aria-label={`${removeLabel} — ${name}`} onClick={onRemove}>
        <X />
      </Button>
    </li>
  );
}

/** Type-to-filter picker; Enter adds the first match. */
function ComponentPicker({
  placeholder,
  emptyLabel,
  options,
  onPick,
}: {
  placeholder: string;
  emptyLabel: string;
  options: { id: string; name: string; hint: string }[];
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const q = query.trim().toLowerCase();
  const matches = (q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options).slice(0, 8);

  function pick(id: string) {
    onPick(id);
    setQuery('');
    setOpen(false);
  }

  return (
    <div className="relative">
      <Plus className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        value={query}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (matches[0]) pick(matches[0].id);
          }
          if (e.key === 'Escape') setOpen(false);
        }}
        className="pl-9"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg"
        >
          {matches.length === 0 ? (
            <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Search className="size-4" aria-hidden />
              {emptyLabel}
            </li>
          ) : (
            matches.map((o) => (
              <li key={o.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o.id)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span className="truncate text-foreground">{o.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
