'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Info,
  Plus,
  Scaling,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  compositionCost,
  DISH_OUTPUT_UNITS,
  DISH_RECIPE_UNITS,
  dishPricing,
  ingredientCanonicalQuantity,
  ingredientLineKey,
  ingredientUnitsFor,
  outputCanonicalQuantity,
  outputDisplayAmount,
  outputKind,
  priceBasisFor,
  priceExclVat,
  priceForMargin,
  priceForTotalCostShare,
  recipeLineKey,
  roundHours,
  scaleComposition,
  type DishComposition,
  type DishCostLookups,
  type DishExtra,
  type DishIngredientUnit,
  type DishOutputUnit,
  type DishRecipeUnit,
} from '@/lib/calculations/dish';
import type {
  DishExtraView,
  DishIngredientOption,
  DishOutputView,
  DishRecipeOption,
  KitchenDishIngredientLine,
  KitchenDishRecipeLine,
} from '@/lib/data/menus';
import { centsToAmountInput, formatMoney, parseMoneyToCents } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createDishAction,
  deleteMenuAction,
  duplicateDishAction,
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
  output: DishOutputView;
  sellingPriceCents: number | null;
  vatRateBps: number | null;
  labour: { hours: number; hourlyCents: number } | null;
  extras: DishExtraView[];
  notes: string | null;
  recipeLines: KitchenDishRecipeLine[];
  ingredientLines: KitchenDishIngredientLine[];
};

type RecipeLineState = { recipeId: string; name: string; quantity: string; unit: DishRecipeUnit };
type IngredientLineState = { ingredientId: string; name: string; quantity: string; unit: DishIngredientUnit };
type ExtraState = {
  key: string;
  kind: 'work' | 'expense';
  description: string;
  hours: string;
  rate: string;
  amount: string;
};
type PricingField = 'incl' | 'margin' | 'totalCost';

function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** A money field: blank → null, otherwise integer cents (or NaN when unreadable/negative). */
function parseMoneyField(text: string): number | null {
  if (text.trim() === '') return null;
  if (!/^\s*[\d.,\s]+\s*$/.test(text)) return Number.NaN;
  return parseMoneyToCents(text);
}

const blankExtra = (kind: 'work' | 'expense'): ExtraState => ({
  key: crypto.randomUUID(),
  kind,
  description: '',
  hours: '',
  rate: '',
  amount: '',
});

/**
 * Menu product builder (one batch). Flow: product + "This batch makes", recipes /
 * ingredients / packaging for the WHOLE batch, labour + extras, then selling price
 * and results. Every figure recomputes on each keystroke through the SAME
 * `compositionCost` the server and every report use; only Save talks to the server.
 *
 * Two distinct intentions: editing "This batch makes" CORRECTS the yield (components
 * unchanged); "Make a different quantity" SCALES every component and asks the chef
 * to review hours and expenses, which are never scaled silently.
 */
export function DishBuilder({
  initial,
  folders,
  recipeOptions,
  ingredientOptions,
  currency,
  defaultVatBps,
  justCopied = false,
}: {
  initial: DishBuilderInitial;
  folders: { id: string; name: string }[];
  recipeOptions: DishRecipeOption[];
  ingredientOptions: DishIngredientOption[];
  currency: string;
  /** The org's sales VAT rate; used when the product has no own rate. */
  defaultVatBps: number | null;
  justCopied?: boolean;
}) {
  const t = useTranslations('menus.builder');
  const tUnits = useTranslations('menus.units');
  const actionError = useActionError();
  const router = useRouter();
  const money = React.useCallback((cents: number) => formatMoney(cents, currency), [currency]);

  const isNew = initial.id === null;
  const recipeById = React.useMemo(() => new Map(recipeOptions.map((r) => [r.id, r])), [recipeOptions]);
  const ingredientById = React.useMemo(() => new Map(ingredientOptions.map((i) => [i.id, i])), [ingredientOptions]);

  // ── State ─────────────────────────────────────────────────────────────────
  const [name, setName] = React.useState(initial.name);
  const [folderId, setFolderId] = React.useState(initial.folderId);
  const [notes, setNotes] = React.useState(initial.notes ?? '');
  const [outputUnit, setOutputUnit] = React.useState<DishOutputUnit>(initial.output.unit);
  const [outputText, setOutputText] = React.useState(
    initial.output.quantity > 0 ? numberToField(initial.output.quantity) : '',
  );
  const [sizeText, setSizeText] = React.useState(initial.output.sizeDescription ?? '');
  const [finishedKgText, setFinishedKgText] = React.useState(
    initial.output.finishedWeightGrams !== null ? numberToField(initial.output.finishedWeightGrams / 1000) : '',
  );
  const [hoursText, setHoursText] = React.useState(initial.labour ? numberToField(initial.labour.hours) : '');
  const [rateText, setRateText] = React.useState(initial.labour ? centsToAmountInput(initial.labour.hourlyCents) : '');
  const [extras, setExtras] = React.useState<ExtraState[]>(() =>
    initial.extras.map((e) => ({
      key: crypto.randomUUID(),
      kind: e.kind,
      description: e.description,
      hours: e.kind === 'work' ? numberToField(e.hours) : '',
      rate: e.kind === 'work' ? centsToAmountInput(e.hourlyCents) : '',
      amount: e.kind === 'expense' ? centsToAmountInput(e.amountCents) : '',
    })),
  );
  const [priceExclCents, setPriceExclCents] = React.useState(initial.sellingPriceCents);
  const [priceText, setPriceText] = React.useState(
    initial.sellingPriceCents !== null ? centsToAmountInput(initial.sellingPriceCents) : '',
  );
  const [vatText, setVatText] = React.useState(
    initial.vatRateBps !== null ? numberToField(initial.vatRateBps / 100) : '',
  );
  const [draft, setDraft] = React.useState<{ field: PricingField; text: string } | null>(null);
  const [morePricing, setMorePricing] = React.useState(false);
  const [recipeLines, setRecipeLines] = React.useState<RecipeLineState[]>(() =>
    initial.recipeLines.map((l) => ({ recipeId: l.recipeId, name: l.recipeName, quantity: numberToField(l.quantity), unit: l.unit })),
  );
  const [ingredientLines, setIngredientLines] = React.useState<IngredientLineState[]>(() =>
    initial.ingredientLines.map((l) => ({
      ingredientId: l.ingredientId,
      name: l.ingredientName,
      quantity: numberToField(l.quantity),
      unit: l.unit,
    })),
  );
  const [reviewAfterScale, setReviewAfterScale] = React.useState(false);

  React.useEffect(() => {
    if (initial.id) void markDishOpenedAction(initial.id);
  }, [initial.id]);

  // ── Output ────────────────────────────────────────────────────────────────
  const kind = outputKind(outputUnit);
  const outputAmount = parseNumber(outputText);
  const outputValid = outputAmount !== null && outputAmount > 0;
  const outputCanonical = outputValid ? outputCanonicalQuantity(outputAmount, outputUnit) : 0;
  const finishedKg = parseNumber(finishedKgText);
  const finishedValid = finishedKgText.trim() === '' || (finishedKg !== null && finishedKg > 0);
  const finishedWeightGrams = kind === 'count' && finishedValid && finishedKg !== null ? finishedKg * 1000 : null;

  const batchLabel = outputValid
    ? t('output.batchOf', {
        unit: outputUnit,
        count: outputAmount,
        amount: numberToField(outputAmount),
      })
    : t('output.thisBatch');
  const perLabel = t(`per.${priceBasisFor(outputUnit) === 'kg' ? 'kg' : outputUnit}`);

  // ── Labour + extras ───────────────────────────────────────────────────────
  const hours = parseNumber(hoursText);
  const rate = parseMoneyField(rateText);
  const labourBlank = hoursText.trim() === '' && rateText.trim() === '';
  const labourValid =
    !labourBlank && hours !== null && hours >= 0 && hours <= 100_000 && rate !== null && Number.isFinite(rate) && rate >= 0;
  const labour: DishComposition['labour'] = labourBlank
    ? null
    : labourValid
      ? { hours: roundHours(hours as number), hourlyCents: rate as number }
      : { hours: Number.NaN, hourlyCents: Number.NaN };

  const extraValues: DishExtra[] = extras.map((e) => {
    if (e.kind === 'work') {
      const h = parseNumber(e.hours);
      const r = parseMoneyField(e.rate);
      return {
        kind: 'work',
        hours: h === null || h < 0 ? Number.NaN : roundHours(h),
        hourlyCents: r === null || !Number.isFinite(r) ? Number.NaN : r,
      };
    }
    const a = parseMoneyField(e.amount);
    return { kind: 'expense', amountCents: a === null || !Number.isFinite(a) ? Number.NaN : a };
  });
  const extrasValid = extras.every(
    (e, i) =>
      e.description.trim() !== '' &&
      (() => {
        const v = extraValues[i];
        return v?.kind === 'work'
          ? Number.isFinite(v.hours) && Number.isFinite(v.hourlyCents)
          : v?.kind === 'expense' && Number.isFinite(v.amountCents);
      })(),
  );

  // ── Cost ──────────────────────────────────────────────────────────────────
  const lookups: DishCostLookups = React.useMemo(
    () => ({
      recipeCostPerPortion: (id, { excludeLabour }) => {
        const r = recipeById.get(id);
        return (excludeLabour ? r?.costPerPortionWithoutLabourCents : r?.costPerPortionCents) ?? null;
      },
      recipeYield: (id) => recipeById.get(id) ?? null,
      ingredient: (id) => ingredientById.get(id) ?? null,
    }),
    [recipeById, ingredientById],
  );

  const composition: DishComposition = {
    output: { quantity: outputCanonical, unit: outputUnit, finishedWeightGrams },
    labour,
    extras: extraValues,
    recipeLines: recipeLines.map((l) => ({ recipeId: l.recipeId, quantity: parseNumber(l.quantity) ?? 0, unit: l.unit })),
    ingredientLines: ingredientLines.map((l) => ({
      ingredientId: l.ingredientId,
      quantity: ingredientCanonicalQuantity(parseNumber(l.quantity) ?? 0, l.unit),
      unit: l.unit,
    })),
  };
  const cost = compositionCost(composition, lookups);
  const lineCost = new Map(cost.lineCosts.map((l) => [l.key, l.costCents]));
  const excludeLabour = labour !== null;

  // ── Pricing ───────────────────────────────────────────────────────────────
  const vatValue = parseNumber(vatText);
  const vatValid = vatText.trim() === '' || (vatValue !== null && vatValue >= 0 && vatValue <= 100);
  const vatBps = vatText.trim() === '' || vatValue === null ? (defaultVatBps ?? 0) : Math.round(vatValue * 100);
  const pricing = dishPricing(cost, priceExclCents, vatBps);
  const exactUnitCost = cost.exactTotalCents !== null && cost.saleUnits ? cost.exactTotalCents / cost.saleUnits : null;
  const priceValid = priceText.trim() === '' || Number.isFinite(parseMoneyField(priceText) ?? 0);

  function setPrice(cents: number | null) {
    setPriceExclCents(cents);
    setPriceText(cents === null ? '' : centsToAmountInput(cents));
  }

  function pricingText(field: PricingField): string {
    if (draft?.field === field) return draft.text;
    if (field === 'incl') return pricing.priceInclCents !== null ? centsToAmountInput(pricing.priceInclCents) : '';
    if (field === 'margin') return pricing.marginBps !== null ? numberToField(pricing.marginBps / 100) : '';
    return pricing.totalCostBps !== null ? numberToField(pricing.totalCostBps / 100) : '';
  }

  function onPricingChange(field: PricingField, text: string) {
    setDraft({ field, text });
    if (field === 'incl') {
      const gross = parseMoneyField(text);
      if (gross === null) setPrice(null);
      else if (Number.isFinite(gross)) {
        const net = priceExclVat(gross, vatBps);
        setPriceExclCents(net);
        setPriceText(centsToAmountInput(net));
      }
      return;
    }
    const pct = parseNumber(text);
    if (pct === null) return;
    const next =
      field === 'margin'
        ? priceForMargin(exactUnitCost, Math.round(pct * 100))
        : priceForTotalCostShare(exactUnitCost, Math.round(pct * 100));
    if (next !== null) {
      setPriceExclCents(next);
      setPriceText(centsToAmountInput(next));
    }
  }

  // ── Unit change (weight ↔ count needs new yield information) ──────────────
  const [unitChange, setUnitChange] = React.useState<DishOutputUnit | null>(null);
  const [unitChangeQty, setUnitChangeQty] = React.useState('');
  const [keepWeight, setKeepWeight] = React.useState(true);

  function requestUnit(next: DishOutputUnit) {
    if (next === outputUnit) return;
    if (outputKind(next) === kind) {
      // Same kind: g ↔ kg converts the number; piece/cake/portion is the same count.
      if (outputValid) setOutputText(numberToField(outputDisplayAmount(outputCanonical, next)));
      setOutputUnit(next);
      return;
    }
    setUnitChangeQty(
      outputKind(next) === 'weight' && finishedWeightGrams !== null
        ? numberToField(outputDisplayAmount(finishedWeightGrams, next))
        : '',
    );
    setKeepWeight(true);
    setUnitChange(next);
  }

  const unitChangeAmount = parseNumber(unitChangeQty);
  function applyUnitChange() {
    if (!unitChange || unitChangeAmount === null || unitChangeAmount <= 0) return;
    if (outputKind(unitChange) === 'count') {
      setFinishedKgText(keepWeight && outputValid ? numberToField(outputCanonical / 1000) : '');
    } else {
      setFinishedKgText('');
    }
    setOutputUnit(unitChange);
    setOutputText(numberToField(unitChangeAmount));
    // The price meant "per kg" or "per piece" — it can't carry over.
    setPrice(null);
    setUnitChange(null);
  }

  // ── Scaling ───────────────────────────────────────────────────────────────
  const [scaling, setScaling] = React.useState(false);
  const [scaleText, setScaleText] = React.useState('');
  const scaleAmount = parseNumber(scaleText);
  const scaled =
    scaling && outputValid && scaleAmount !== null && scaleAmount > 0
      ? scaleComposition(
          {
            ...composition,
            recipeLines: recipeLines.map((l) => ({ recipeId: l.recipeId, quantity: parseNumber(l.quantity) ?? 0, unit: l.unit })),
            ingredientLines: ingredientLines.map((l) => ({ ingredientId: l.ingredientId, quantity: parseNumber(l.quantity) ?? 0, unit: l.unit })),
          },
          outputCanonicalQuantity(scaleAmount, outputUnit),
        )
      : null;

  function applyScale() {
    if (!scaled) return;
    setRecipeLines((prev) => prev.map((l, i) => ({ ...l, quantity: numberToField(scaled.recipeLines[i]?.quantity ?? 0) })));
    setIngredientLines((prev) =>
      prev.map((l, i) => ({ ...l, quantity: numberToField(scaled.ingredientLines[i]?.quantity ?? 0) })),
    );
    setOutputText(numberToField(outputDisplayAmount(scaled.output.quantity, outputUnit)));
    if (scaled.output.finishedWeightGrams !== null) {
      setFinishedKgText(numberToField(scaled.output.finishedWeightGrams / 1000));
    }
    setReviewAfterScale(true);
    setScaling(false);
  }

  // ── Lines ─────────────────────────────────────────────────────────────────
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
  const patchExtra = (key: string, patch: Partial<ExtraState>) =>
    setExtras((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  // ── Save / dirty ──────────────────────────────────────────────────────────
  const unavailable =
    recipeLines.some((l) => !recipeById.has(l.recipeId)) || ingredientLines.some((l) => !ingredientById.has(l.ingredientId));
  const invalidQuantity = [...recipeLines, ...ingredientLines].some((l) => {
    const q = parseNumber(l.quantity);
    return q === null || q <= 0;
  });

  const payload = {
    name: name.trim(),
    folderId,
    output: {
      quantity: outputAmount ?? 0,
      unit: outputUnit,
      sizeDescription: sizeText.trim() === '' ? null : sizeText.trim(),
      finishedWeightGrams,
    },
    sellingPriceCents: priceExclCents,
    priceBasis: priceBasisFor(outputUnit),
    vatRateBps: vatText.trim() === '' || vatValue === null ? null : Math.round(vatValue * 100),
    labour: labourValid ? labour : null,
    extras: extras.map((e, i) => {
      const v = extraValues[i] as DishExtra;
      return v.kind === 'work'
        ? { kind: 'work' as const, description: e.description.trim(), hours: v.hours, hourlyCents: v.hourlyCents }
        : { kind: 'expense' as const, description: e.description.trim(), amountCents: v.amountCents };
    }),
    notes: notes.trim() === '' ? null : notes.trim(),
    recipeLines: recipeLines.map((l) => ({ recipeId: l.recipeId, quantity: parseNumber(l.quantity) ?? 0, unit: l.unit })),
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
    !outputValid && t('problems.output'),
    !finishedValid && t('problems.finishedWeight'),
    !labourBlank && !labourValid && t('problems.labour'),
    !extrasValid && t('problems.extras'),
    !vatValid && t('problems.vat'),
    !priceValid && t('problems.price'),
    invalidQuantity && t('problems.quantity'),
    unavailable && t('problems.unavailable'),
    reviewAfterScale && t('problems.review'),
  ].filter((p): p is string => typeof p === 'string');
  const canSave = problems.length === 0;

  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [copying, setCopying] = React.useState(false);
  const [copyName, setCopyName] = React.useState('');
  const [copyBanner, setCopyBanner] = React.useState(justCopied);

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

  function makeCopy() {
    if (!initial.id || copyName.trim() === '') return;
    startTransition(async () => {
      const result = await duplicateDishAction(initial.id as string, { name: copyName.trim() });
      if (!result.ok) {
        setCopying(false);
        return setError(actionError(result.code));
      }
      setCopying(false);
      router.push(`/menus/${result.data.id}?copied=1`);
    });
  }

  const backHref = initial.folderId ? `/menus/folders/${initial.folderId}` : isNew ? '/menus' : '/menus/folders/unfiled';
  const unitCostText = cost.costPerSaleUnitCents !== null ? `${money(cost.costPerSaleUnitCents)} ${perLabel}` : '—';

  const saveButton = (
    <Button type="submit" size="lg" disabled={!canSave || pending || (!dirty && !isNew)} className="w-full sm:w-auto">
      {pending ? t('saving') : isNew ? t('create') : t('save')}
    </Button>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="mx-auto flex w-full max-w-6xl flex-col gap-5 pb-28 lg:pb-0"
    >
      {/* Header */}
      <div className="flex flex-col gap-3">
        <Link href={backHref} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          {t('back')}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="min-w-0 truncate font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {name.trim() || t('untitled')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {justSaved && !dirty && (
              <span role="status" className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
                <Check className="size-4" /> {t('saved')}
              </span>
            )}
            {dirty && !isNew && <span className="text-sm text-muted-foreground">{t('unsaved')}</span>}
            {!isNew && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={dirty}
                  title={dirty ? t('copy.saveFirst') : undefined}
                  onClick={() => {
                    setCopyName(t('copy.defaultName', { name: name.trim() }));
                    setCopying(true);
                  }}
                >
                  <Copy />
                  {t('copy.action')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  <Trash2 />
                  <span className="hidden sm:inline">{t('delete')}</span>
                </Button>
              </>
            )}
            <div className="hidden lg:block">{saveButton}</div>
          </div>
        </div>
        {copyBanner && (
          <Notice tone="info" onDismiss={() => setCopyBanner(false)} dismissLabel={t('dismiss')}>
            {t('copy.banner')}
          </Notice>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
            {error}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* 1. Product + batch output */}
          <Section step={1} title={t('sections.product')}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Field id="dish-name" label={t('fields.name')}>
                <Input
                  id="dish-name"
                  value={name}
                  maxLength={200}
                  autoFocus={isNew || justCopied}
                  placeholder={t('fields.namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                  className="h-12 text-base"
                />
              </Field>
              <Field id="dish-folder" label={t('fields.folder')}>
                <Select id="dish-folder" value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value === '' ? null : e.target.value)} className="h-12 text-base">
                  <option value="">{t('fields.unfiled')}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-4">
              <Label htmlFor="output-qty" className="text-base">
                {t('output.makes')}
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="output-qty"
                  inputMode="decimal"
                  value={outputText}
                  aria-invalid={!outputValid}
                  onChange={(e) => setOutputText(e.target.value)}
                  className="h-12 w-36 bg-surface text-right text-lg tabular-nums"
                />
                <div className="w-36">
                  <Select
                    aria-label={t('output.unit')}
                    value={outputUnit}
                    onChange={(e) => requestUnit(e.target.value as DishOutputUnit)}
                    className="h-12 bg-surface text-base"
                  >
                    {DISH_OUTPUT_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {tUnits(`output.${u}`)}
                      </option>
                    ))}
                  </Select>
                </div>
                {kind === 'count' && (
                  <div className="flex items-center gap-2">
                    <Label htmlFor="output-size" className="text-sm text-muted-foreground">
                      {t('output.size')}
                    </Label>
                    <Input
                      id="output-size"
                      value={sizeText}
                      maxLength={80}
                      placeholder={t('output.sizePlaceholder')}
                      onChange={(e) => setSizeText(e.target.value)}
                      className="h-12 w-32 bg-surface"
                    />
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('output.yieldHint')}</p>
              {kind === 'count' && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Label htmlFor="finished-weight" className="text-sm">
                    {t('output.finishedWeight')}
                  </Label>
                  <div className="relative">
                    <Input
                      id="finished-weight"
                      inputMode="decimal"
                      value={finishedKgText}
                      aria-invalid={!finishedValid}
                      placeholder={t('optional')}
                      onChange={(e) => setFinishedKgText(e.target.value)}
                      className="h-10 w-32 bg-surface pr-9 text-right tabular-nums"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">kg</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{t('output.finishedWeightHint')}</span>
                </div>
              )}
              <div className="pt-1">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!outputValid}
                  onClick={() => {
                    setScaleText(outputText);
                    setScaling(true);
                  }}
                  className="bg-surface"
                >
                  <Scaling />
                  {t('scale.action')}
                </Button>
              </div>
            </div>

            <Field id="dish-notes" label={t('fields.notes')}>
              <Textarea id="dish-notes" value={notes} maxLength={1000} placeholder={t('fields.notesPlaceholder')} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </Section>

          {/* 2. Components */}
          <Section step={2} title={t('sections.components')}>
            <p className="rounded-lg bg-accent-50 px-3 py-2 text-sm font-medium text-accent-800 dark:bg-accent-500/15 dark:text-accent-200">
              {outputValid ? t('components.wholeBatch', { batch: batchLabel }) : t('components.wholeBatchUnknown')}
            </p>

            <h4 className="text-sm font-semibold text-foreground">{t('recipes.title')}</h4>
            {recipeLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('recipes.empty')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {recipeLines.map((line, index) => {
                  const option = recipeById.get(line.recipeId);
                  const contribution = lineCost.get(recipeLineKey(line.recipeId)) ?? null;
                  const perKg = excludeLabour ? option?.costPerKgWithoutLabourCents : option?.costPerKgCents;
                  const perPortion = excludeLabour ? option?.costPerPortionWithoutLabourCents : option?.costPerPortionCents;
                  const unitCost =
                    perKg != null
                      ? t('recipes.perKg', { amount: money(perKg) })
                      : perPortion != null
                        ? t('recipes.perPortion', { amount: money(perPortion) })
                        : null;
                  const units = DISH_RECIPE_UNITS.filter((u) => u === 'portion' || option?.yieldWeightGrams || u === line.unit);
                  const q = parseNumber(line.quantity);
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
                      warning={option && line.unit !== 'portion' && !option.yieldWeightGrams ? t('recipes.needsWeight') : undefined}
                      quantity={line.quantity}
                      quantityInvalid={q === null || q <= 0}
                      onQuantity={(value) => setRecipeLines((prev) => prev.map((l, i) => (i === index ? { ...l, quantity: value } : l)))}
                      unit={line.unit}
                      units={units.map((u) => ({ value: u, label: tUnits(u) }))}
                      onUnit={(value) =>
                        setRecipeLines((prev) => prev.map((l, i) => (i === index ? { ...l, unit: value as DishRecipeUnit } : l)))
                      }
                      contribution={contribution !== null ? money(contribution) : '—'}
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
                .map((r) => {
                  const perKg = excludeLabour ? r.costPerKgWithoutLabourCents : r.costPerKgCents;
                  const perPortion = excludeLabour ? r.costPerPortionWithoutLabourCents : r.costPerPortionCents;
                  return {
                    id: r.id,
                    name: r.name,
                    hint:
                      perKg !== null
                        ? t('recipes.perKg', { amount: money(perKg) })
                        : perPortion !== null
                          ? t('recipes.perPortion', { amount: money(perPortion) })
                          : t('needsPricing'),
                  };
                })}
              onPick={(id) => {
                const option = recipeById.get(id);
                if (option) addRecipe(option);
              }}
            />

            <h4 className="pt-2 text-sm font-semibold text-foreground">{t('ingredients.title')}</h4>
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
                          <span>{t(`ingredients.per.${option.dimension}`, { amount: money(option.priceCents) })}</span>
                        )
                      }
                      quantity={line.quantity}
                      quantityInvalid={q === null || q <= 0}
                      onQuantity={(value) =>
                        setIngredientLines((prev) => prev.map((l, i) => (i === index ? { ...l, quantity: value } : l)))
                      }
                      unit={line.unit}
                      units={(option ? ingredientUnitsFor(option.dimension) : [line.unit]).map((u) => ({ value: u, label: tUnits(u) }))}
                      onUnit={(value) =>
                        setIngredientLines((prev) =>
                          prev.map((l, i) => (i === index ? { ...l, unit: value as DishIngredientUnit } : l)),
                        )
                      }
                      contribution={contribution !== null ? money(contribution) : '—'}
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
                  hint: i.needsPricing ? t('needsPricing') : t(`ingredients.per.${i.dimension}`, { amount: money(i.priceCents) }),
                }))}
              onPick={(id) => {
                const option = ingredientById.get(id);
                if (option) addIngredient(option);
              }}
            />
          </Section>

          {/* 3. Labour + extras */}
          <Section step={3} title={t('sections.labour')}>
            {reviewAfterScale && (
              <Notice tone="warning">
                <span className="flex flex-col gap-2">
                  <span>{t('scale.review')}</span>
                  <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setReviewAfterScale(false)}>
                    <Check />
                    {t('scale.reviewed')}
                  </Button>
                </span>
              </Notice>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field id="labour-hours" label={outputValid ? t('labour.hoursFor', { batch: batchLabel }) : t('labour.hours')}>
                <Input
                  id="labour-hours"
                  inputMode="decimal"
                  value={hoursText}
                  placeholder={t('optional')}
                  aria-invalid={!labourBlank && !labourValid}
                  onChange={(e) => setHoursText(e.target.value)}
                  className="h-12 text-right text-base tabular-nums"
                />
              </Field>
              <Field id="labour-rate" label={t('labour.rate', { currency })}>
                <Input
                  id="labour-rate"
                  inputMode="decimal"
                  value={rateText}
                  placeholder={t('optional')}
                  aria-invalid={!labourBlank && !labourValid}
                  onChange={(e) => setRateText(e.target.value)}
                  className="h-12 text-right text-base tabular-nums"
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">{t('labour.cost')}</span>
                <span className="flex h-12 items-center justify-end rounded-lg bg-surface-2 px-3 text-base font-semibold tabular-nums">
                  {labourBlank ? '—' : cost.productionLabourCents !== null ? money(cost.productionLabourCents) : '—'}
                </span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('labour.hint')}</p>
            {!labourBlank && !labourValid && <p className="text-sm text-red-700 dark:text-red-300">{t('problems.labour')}</p>}
            {labourValid && <Notice tone="info">{t('labour.replacesRecipeLabour')}</Notice>}
            {labourBlank && cost.inheritsRecipeLabour && <Notice tone="info">{t('labour.legacy')}</Notice>}

            <div className="flex flex-col gap-3 border-t border-border pt-4">
              {extras.length > 0 && (
                <ul className="flex flex-col gap-3">
                  {extras.map((extra, index) => {
                    const v = extraValues[index];
                    const amount =
                      v?.kind === 'work'
                        ? Number.isFinite(v.hours) && Number.isFinite(v.hourlyCents)
                          ? money(Math.round(v.hours * v.hourlyCents))
                          : '—'
                        : v && Number.isFinite(v.amountCents)
                          ? money(v.amountCents)
                          : '—';
                    return (
                      <li key={extra.key} className="flex flex-wrap items-end gap-2 rounded-xl border border-border p-3">
                        <Field id={`extra-desc-${extra.key}`} label={extra.kind === 'work' ? t('extras.workLabel') : t('extras.expenseLabel')} className="min-w-40 flex-1">
                          <Input
                            id={`extra-desc-${extra.key}`}
                            value={extra.description}
                            maxLength={120}
                            aria-invalid={extra.description.trim() === ''}
                            placeholder={extra.kind === 'work' ? t('extras.workPlaceholder') : t('extras.expensePlaceholder')}
                            onChange={(e) => patchExtra(extra.key, { description: e.target.value })}
                          />
                        </Field>
                        {extra.kind === 'work' ? (
                          <>
                            <Field id={`extra-hours-${extra.key}`} label={t('extras.hours')} className="w-24">
                              <Input
                                id={`extra-hours-${extra.key}`}
                                inputMode="decimal"
                                value={extra.hours}
                                onChange={(e) => patchExtra(extra.key, { hours: e.target.value })}
                                className="text-right tabular-nums"
                              />
                            </Field>
                            <Field id={`extra-rate-${extra.key}`} label={t('extras.rate')} className="w-28">
                              <Input
                                id={`extra-rate-${extra.key}`}
                                inputMode="decimal"
                                value={extra.rate}
                                onChange={(e) => patchExtra(extra.key, { rate: e.target.value })}
                                className="text-right tabular-nums"
                              />
                            </Field>
                          </>
                        ) : (
                          <Field id={`extra-amount-${extra.key}`} label={t('extras.amount')} className="w-32">
                            <Input
                              id={`extra-amount-${extra.key}`}
                              inputMode="decimal"
                              value={extra.amount}
                              onChange={(e) => patchExtra(extra.key, { amount: e.target.value })}
                              className="text-right tabular-nums"
                            />
                          </Field>
                        )}
                        <span className="flex h-10 w-24 items-center justify-end text-sm font-semibold tabular-nums">{amount}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`${t('remove')} — ${extra.description}`}
                          onClick={() => setExtras((prev) => prev.filter((e) => e.key !== extra.key))}
                        >
                          <X />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => setExtras((prev) => [...prev, blankExtra('work')])}>
                  <Plus />
                  {t('extras.addWork')}
                </Button>
                <Button type="button" variant="outline" onClick={() => setExtras((prev) => [...prev, blankExtra('expense')])}>
                  <Plus />
                  {t('extras.addExpense')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('extras.reminder')}</p>
            </div>
          </Section>

          {/* 4. Selling price */}
          <Section step={4} title={t('sections.price')}>
            <Field id="price" label={t('price.label', { per: perLabel })}>
              <div className="relative">
                <Input
                  id="price"
                  inputMode="decimal"
                  value={priceText}
                  placeholder="0.00"
                  aria-invalid={!priceValid}
                  onChange={(e) => {
                    setPriceText(e.target.value);
                    const cents = parseMoneyField(e.target.value);
                    if (cents === null) setPriceExclCents(null);
                    else if (Number.isFinite(cents)) setPriceExclCents(cents);
                  }}
                  className="h-14 pr-28 text-right text-xl font-semibold tabular-nums"
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  {perLabel}
                </span>
              </div>
            </Field>
            <p className="text-xs text-muted-foreground">{t('price.hint')}</p>

            <button
              type="button"
              onClick={() => setMorePricing((open) => !open)}
              aria-expanded={morePricing}
              className="inline-flex w-fit cursor-pointer items-center gap-1 text-sm font-medium text-accent-700 hover:underline dark:text-accent-300"
            >
              <ChevronDown className={cn('size-4 transition-transform', !morePricing && '-rotate-90')} />
              {t('price.more')}
            </button>
            {morePricing && (
              <div className="grid grid-cols-1 gap-4 rounded-xl bg-surface-2 p-4 sm:grid-cols-2">
                <SmallInput
                  id="price-incl"
                  label={t('price.incl', { per: perLabel })}
                  value={pricingText('incl')}
                  onChange={(v) => onPricingChange('incl', v)}
                  onBlur={() => setDraft(null)}
                />
                <SmallInput
                  id="vat"
                  label={t('price.vat')}
                  value={vatText}
                  suffix="%"
                  invalid={!vatValid}
                  placeholder={defaultVatBps !== null ? numberToField(defaultVatBps / 100) : '0'}
                  hint={vatText.trim() === '' ? t('price.vatDefault') : undefined}
                  onChange={setVatText}
                />
                <SmallInput
                  id="margin"
                  label={t('price.margin')}
                  value={pricingText('margin')}
                  suffix="%"
                  disabled={exactUnitCost === null}
                  onChange={(v) => onPricingChange('margin', v)}
                  onBlur={() => setDraft(null)}
                />
                <SmallInput
                  id="total-cost-pct"
                  label={t('price.totalCostPct')}
                  value={pricingText('totalCost')}
                  suffix="%"
                  disabled={exactUnitCost === null}
                  onChange={(v) => onPricingChange('totalCost', v)}
                  onBlur={() => setDraft(null)}
                />
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  {exactUnitCost === null ? t('price.moreNoCost') : t('price.moreHint')}
                </p>
              </div>
            )}
          </Section>
        </div>

        {/* Results */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start" aria-label={t('results.title')}>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>{t('results.title')}</CardTitle>
              <p className="text-xs text-muted-foreground">{t('results.vatBasis')}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <dl className="flex flex-col gap-2 text-sm">
                <Row label={t('results.components')} value={cost.componentsCents !== null ? money(cost.componentsCents) : '—'} />
                <Row
                  label={t('results.labour')}
                  value={labourBlank ? t('results.labourNotEntered') : cost.productionLabourCents !== null ? money(cost.productionLabourCents) : '—'}
                  muted={labourBlank}
                />
                <Row label={t('results.extraWork')} value={cost.extraWorkCents !== null ? money(cost.extraWorkCents) : '—'} />
                <Row label={t('results.expenses')} value={cost.expensesCents !== null ? money(cost.expensesCents) : '—'} />
                <Row strong label={t('results.total')} value={cost.totalCostCents !== null ? money(cost.totalCostCents) : '—'} />
                <Row label={t('results.costPerUnit')} value={unitCostText} />
                {kind === 'count' && cost.costPerKgCents !== null && (
                  <Row label={t('results.costPerKg')} value={`${money(cost.costPerKgCents)} ${t('per.kg')}`} />
                )}
              </dl>

              <dl className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
                <Row
                  label={t('results.price')}
                  value={pricing.priceExclCents !== null ? `${money(pricing.priceExclCents)} ${perLabel}` : '—'}
                />
                <Row
                  label={t('results.sales', { batch: batchLabel })}
                  value={pricing.estimatedSalesCents !== null ? money(pricing.estimatedSalesCents) : '—'}
                />
                <div className="flex items-baseline justify-between gap-2 pt-1">
                  <dt className="font-medium text-foreground">{t('results.left')}</dt>
                  <dd className="flex items-center gap-2">
                    <span
                      className={cn(
                        'font-display text-2xl font-semibold tabular-nums',
                        pricing.amountLeftCents !== null && pricing.amountLeftCents < 0 ? 'text-red-700 dark:text-red-300' : 'text-foreground',
                      )}
                    >
                      {pricing.amountLeftCents !== null ? money(pricing.amountLeftCents) : '—'}
                    </span>
                  </dd>
                </div>
                {pricing.marginBps !== null && (
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={marginVariant(pricing.marginBps)}>
                      {t('results.leftPct', { pct: formatPercentBps(pricing.marginBps) })}
                    </Badge>
                    {pricing.totalCostBps !== null && (
                      <Badge variant="neutral">{t('results.totalCostPct', { pct: formatPercentBps(pricing.totalCostBps) })}</Badge>
                    )}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{t('results.assumption')}</p>
              </dl>

              {!cost.complete && (recipeLines.length > 0 || ingredientLines.length > 0) && (
                <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {!outputValid
                    ? t('results.outputMissing')
                    : !labourBlank && !labourValid
                      ? t('problems.labour')
                      : !extrasValid
                        ? t('problems.extras')
                        : t('results.incomplete')}
                </p>
              )}

              {!canSave && (name !== '' || recipeLines.length > 0 || !isNew) && (
                <ul className="flex flex-col gap-1 text-xs text-red-700 dark:text-red-300">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <div className="hidden lg:block [&>button]:w-full">{saveButton}</div>
            </CardContent>
          </Card>
        </aside>
      </div>

      {/* Mobile: the key numbers + Save stay in reach. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col text-xs">
            <span className="truncate text-muted-foreground">
              {t('results.total')}: <span className="tabular-nums text-foreground">{cost.totalCostCents !== null ? money(cost.totalCostCents) : '—'}</span>
            </span>
            <span className="truncate font-medium text-foreground">
              {t('results.left')}: {pricing.amountLeftCents !== null ? money(pricing.amountLeftCents) : '—'}
            </span>
          </div>
          <div className="shrink-0">{saveButton}</div>
        </div>
      </div>

      {/* Weight ↔ count needs new yield information */}
      <ConfirmDialog
        open={unitChange !== null}
        title={t('unitChange.title')}
        description={
          unitChange
            ? outputKind(unitChange) === 'count'
              ? t('unitChange.toCount', { unit: tUnits(`output.${unitChange}`) })
              : t('unitChange.toWeight', { unit: tUnits(`output.${unitChange}`) })
            : ''
        }
        confirmLabel={t('unitChange.confirm')}
        cancelLabel={t('cancel')}
        onConfirm={applyUnitChange}
        onCancel={() => setUnitChange(null)}
      >
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex items-center gap-2">
            <Input
              inputMode="decimal"
              autoFocus
              value={unitChangeQty}
              aria-label={t('output.makes')}
              onChange={(e) => setUnitChangeQty(e.target.value)}
              className="h-12 w-36 text-right text-lg tabular-nums"
            />
            <span className="text-sm text-muted-foreground">{unitChange ? tUnits(`output.${unitChange}`) : ''}</span>
          </div>
          {unitChange && outputKind(unitChange) === 'count' && outputValid && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={keepWeight} onChange={(e) => setKeepWeight(e.target.checked)} />
              {t('unitChange.keepWeight', { kg: numberToField(outputCanonical / 1000) })}
            </label>
          )}
          <p className="text-xs text-muted-foreground">{t('unitChange.priceReset')}</p>
        </div>
      </ConfirmDialog>

      {/* Make a different quantity */}
      <ConfirmDialog
        open={scaling}
        title={t('scale.title')}
        description={t('scale.description')}
        confirmLabel={t('scale.apply')}
        cancelLabel={t('cancel')}
        onConfirm={applyScale}
        onCancel={() => setScaling(false)}
      >
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex items-center gap-2">
            <span className="text-sm">{t('scale.makeInstead')}</span>
            <Input
              inputMode="decimal"
              autoFocus
              value={scaleText}
              aria-label={t('scale.makeInstead')}
              onChange={(e) => setScaleText(e.target.value)}
              className="h-11 w-28 text-right tabular-nums"
            />
            <span className="text-sm text-muted-foreground">{tUnits(`output.${outputUnit}`)}</span>
          </div>
          {scaled && (
            <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-lg border border-border text-sm">
              {recipeLines.map((l, i) => (
                <PreviewRow key={l.recipeId} name={l.name} from={l.quantity} to={numberToField(scaled.recipeLines[i]?.quantity ?? 0)} unit={tUnits(l.unit)} />
              ))}
              {ingredientLines.map((l, i) => (
                <PreviewRow key={l.ingredientId} name={l.name} from={l.quantity} to={numberToField(scaled.ingredientLines[i]?.quantity ?? 0)} unit={tUnits(l.unit)} />
              ))}
              {finishedWeightGrams !== null && scaled.output.finishedWeightGrams !== null && (
                <PreviewRow
                  name={t('output.finishedWeight')}
                  from={numberToField(finishedWeightGrams / 1000)}
                  to={numberToField(scaled.output.finishedWeightGrams / 1000)}
                  unit="kg"
                />
              )}
            </ul>
          )}
          <p className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {t('scale.notScaled')}
          </p>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={copying}
        title={t('copy.title')}
        description={t('copy.description')}
        confirmLabel={t('copy.confirm')}
        cancelLabel={t('cancel')}
        pending={pending}
        onConfirm={makeCopy}
        onCancel={() => setCopying(false)}
      >
        <Input value={copyName} maxLength={200} autoFocus aria-label={t('fields.name')} onChange={(e) => setCopyName(e.target.value)} className="mt-2 h-12" />
      </ConfirmDialog>

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

function Section({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 pb-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-700 text-sm font-semibold text-white">
          {step}
        </span>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function Field({ id, label, children, className }: { id: string; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Notice({
  tone,
  children,
  onDismiss,
  dismissLabel,
}: {
  tone: 'info' | 'warning';
  children: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg p-3 text-sm',
        tone === 'info'
          ? 'bg-surface-2 text-foreground'
          : 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
      )}
    >
      {tone === 'info' ? <Info className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label={dismissLabel} className="cursor-pointer text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

function SmallInput({
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
      <Label htmlFor={id}>{label}</Label>
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
          className={cn('bg-surface text-right tabular-nums', suffix && 'pr-8')}
        />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-2', strong && 'border-t border-border pt-2')}>
      <dt className={cn(strong ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{label}</dt>
      <dd className={cn('text-right tabular-nums', strong ? 'font-semibold text-foreground' : muted ? 'text-muted-foreground' : 'font-medium text-foreground')}>
        {value}
      </dd>
    </div>
  );
}

function PreviewRow({ name, from, to, unit }: { name: string; from: string; to: string; unit: string }) {
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-2">
      <span className="truncate">{name}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {from} → <span className="font-semibold text-foreground">{to}</span> {unit}
      </span>
    </li>
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
        className="h-11 w-24 text-right text-base tabular-nums"
      />
      <div className="w-28">
        <Select value={unit} aria-label={`${unitLabel} — ${name}`} onChange={(e) => onUnit(e.target.value)} className="h-11">
          {units.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </Select>
      </div>
      <span className="ml-auto w-24 text-right text-sm font-medium tabular-nums text-foreground">{contribution}</span>
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
        className="h-11 pl-9"
      />
      {open && (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg">
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
