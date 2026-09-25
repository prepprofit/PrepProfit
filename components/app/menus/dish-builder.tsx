'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, Check, Copy, Info, Plus, Search, Trash2, X } from 'lucide-react';
import {
  compositionCost,
  ingredientCanonicalQuantity,
  ingredientLineKey,
  ingredientUnitsFor,
  outputKind,
  portionPricing,
  priceExclVat,
  priceForMargin,
  priceInclVat,
  recipeLineKey,
  roundHours,
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
import { folderAncestorLabel } from '@/lib/folders/tree';
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
import { formatPercentBps, numberToField } from './dish-format';

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

/** Portions are whole numbers; the same upper bound the batch output had. */
const MAX_PORTIONS = 100_000;

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

function parsePortions(text: string): number | null {
  const value = parseNumber(text);
  return value !== null && Number.isInteger(value) && value >= 1 && value <= MAX_PORTIONS ? value : null;
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
 * Dish editor — a per-portion selling-price and margin calculator. The order is
 * fixed: name, folder, selling price (excl./incl. VAT), number of portions, the
 * margin calculator, then recipes, direct ingredients, labour and extras.
 *
 * Every quantity and cost below covers ALL the portions entered. Cost per portion is
 * total cost ÷ portions: changing the number of portions redistributes the cost and
 * never rescales a quantity. Every figure comes from the shared `compositionCost` +
 * `portionPricing` (the same maths the Menu list, sales and insights use). A
 * suggested price is only applied on "Use this price" — the chef's price is never
 * overwritten.
 *
 * A product saved earlier as a WEIGHT batch (priced per kg) is never reinterpreted:
 * the editor asks for its portions and a price per portion, and keeps the weight as
 * the finished batch weight. Until then it can't be saved.
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
  folders: { id: string; name: string; parentId: string | null }[];
  recipeOptions: DishRecipeOption[];
  ingredientOptions: DishIngredientOption[];
  currency: string;
  /** The org's sales VAT rate; used when the dish has no own rate. */
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
  const legacyWeight = outputKind(initial.output.unit) === 'weight';
  /** Grams of a converted weight batch, kept as its finished weight. */
  const [convertedGrams, setConvertedGrams] = React.useState<number | null>(null);
  const needsConversion = legacyWeight && convertedGrams === null;
  /** Count products keep their stored unit (piece / cake / portion); the rest become portions. */
  const countUnit: DishOutputUnit = legacyWeight ? 'portion' : initial.output.unit;

  const [name, setName] = React.useState(initial.name);
  const [folderId, setFolderId] = React.useState(initial.folderId);
  const [notes, setNotes] = React.useState(initial.notes ?? '');
  const [portionsText, setPortionsText] = React.useState(
    legacyWeight ? '' : initial.output.quantity > 0 ? numberToField(initial.output.quantity) : '1',
  );
  const [priceExclCents, setPriceExclCents] = React.useState(legacyWeight ? null : initial.sellingPriceCents);
  const [priceDraft, setPriceDraft] = React.useState<{ field: 'excl' | 'incl'; text: string } | null>(null);
  const [vatText, setVatText] = React.useState(
    initial.vatRateBps !== null ? numberToField(initial.vatRateBps / 100) : '',
  );
  const [targetText, setTargetText] = React.useState('');
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
  // Recipe components are entered in grams. Older kilogram lines convert exactly;
  // recipe-portion lines stay as saved until corrected (see the recipes section).
  const [recipeLines, setRecipeLines] = React.useState<RecipeLineState[]>(() =>
    initial.recipeLines.map((l) =>
      l.unit === 'kg'
        ? { recipeId: l.recipeId, name: l.recipeName, quantity: numberToField(l.quantity * 1000), unit: 'g' as const }
        : { recipeId: l.recipeId, name: l.recipeName, quantity: numberToField(l.quantity), unit: l.unit },
    ),
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

  // ── Portions + VAT ────────────────────────────────────────────────────────
  const portions = parsePortions(portionsText);
  const vatValue = parseNumber(vatText);
  const vatBlank = vatText.trim() === '';
  const vatValid = vatBlank || (vatValue !== null && vatValue >= 0 && vatValue <= 100);
  const vatBps = vatBlank || !vatValid || vatValue === null ? (defaultVatBps ?? 0) : Math.round(vatValue * 100);

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
  const extrasValid = extras.every((e, i) => {
    const v = extraValues[i];
    const numbersValid =
      v?.kind === 'work'
        ? Number.isFinite(v.hours) && Number.isFinite(v.hourlyCents)
        : v?.kind === 'expense' && Number.isFinite(v.amountCents);
    return e.description.trim() !== '' && numbersValid;
  });

  // ── Cost + pricing ────────────────────────────────────────────────────────
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

  const cost = compositionCost(
    {
      // Portions are the sale units; the finished weight plays no part in the price.
      output: { quantity: portions ?? 0, unit: countUnit, finishedWeightGrams: null },
      labour,
      extras: extraValues,
      recipeLines: recipeLines.map((l) => ({ recipeId: l.recipeId, quantity: parseNumber(l.quantity) ?? 0, unit: l.unit })),
      ingredientLines: ingredientLines.map((l) => ({
        ingredientId: l.ingredientId,
        quantity: ingredientCanonicalQuantity(parseNumber(l.quantity) ?? 0, l.unit),
        unit: l.unit,
      })),
    },
    lookups,
  );
  const lineCost = new Map(cost.lineCosts.map((l) => [l.key, l.costCents]));
  const excludeLabour = labour !== null;
  const pricing = portionPricing(cost, priceExclCents, vatBps);

  const targetValue = parseNumber(targetText);
  const targetBps = targetValue !== null && targetValue >= 0 && targetValue < 100 ? Math.round(targetValue * 100) : null;
  const suggestedExcl = targetBps !== null ? priceForMargin(pricing.exactCostPerPortionCents, targetBps) : null;
  const suggestedIncl = suggestedExcl !== null ? priceInclVat(suggestedExcl, vatBps) : null;

  function priceText(field: 'excl' | 'incl'): string {
    if (priceDraft?.field === field) return priceDraft.text;
    const cents = field === 'excl' ? pricing.priceExclCents : pricing.priceInclCents;
    return cents !== null ? centsToAmountInput(cents) : '';
  }

  function onPriceChange(field: 'excl' | 'incl', text: string) {
    setPriceDraft({ field, text });
    const cents = parseMoneyField(text);
    if (cents === null) setPriceExclCents(null);
    else if (Number.isFinite(cents)) setPriceExclCents(field === 'excl' ? cents : priceExclVat(cents, vatBps));
  }
  const priceInvalid =
    priceDraft !== null && priceDraft.text.trim() !== '' && !Number.isFinite(parseMoneyField(priceDraft.text) ?? 0);

  /** Why the calculator can't show every figure yet — the first missing piece wins. */
  const missingReason = needsConversion
    ? t('calc.missing.convert')
    : portions === null
      ? t('calc.missing.portions')
      : recipeLines.length + ingredientLines.length + extras.length === 0 && labourBlank
        ? t('calc.missing.costs')
        : !labourBlank && !labourValid
          ? t('calc.missing.labour')
          : !extrasValid
            ? t('calc.missing.extras')
            : !cost.complete
              ? t('calc.missing.unpriced')
              : pricing.priceExclCents === null || pricing.priceExclCents <= 0
                ? t('calc.missing.price')
                : null;

  // ── Lines ─────────────────────────────────────────────────────────────────
  function addRecipe(option: DishRecipeOption) {
    setRecipeLines((prev) => [
      ...prev,
      // Always grams; a recipe without a finished weight is flagged, never guessed.
      { recipeId: option.id, name: option.name, quantity: '100', unit: 'g' },
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

  // ── Weight batch → portions (explicit and lossless) ───────────────────────
  const [convertPortionsText, setConvertPortionsText] = React.useState('');
  const [convertPriceText, setConvertPriceText] = React.useState('');
  const convertPortions = parsePortions(convertPortionsText);
  const convertPrice = parseMoneyField(convertPriceText);
  const canConvert = convertPortions !== null && (convertPrice === null || Number.isFinite(convertPrice));

  function applyConversion() {
    if (!canConvert || convertPortions === null) return;
    const grams = initial.output.unit === 'kg' ? initial.output.quantity * 1000 : initial.output.quantity;
    setConvertedGrams(grams);
    setPortionsText(String(convertPortions));
    setPriceExclCents(convertPrice);
    setPriceDraft(null);
  }

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
      quantity: portions ?? 0,
      unit: countUnit,
      // Kept exactly as stored. A converted weight batch keeps its weight here.
      sizeDescription: initial.output.sizeDescription,
      finishedWeightGrams: legacyWeight ? convertedGrams : initial.output.finishedWeightGrams,
    },
    sellingPriceCents: priceExclCents,
    priceBasis: 'unit' as const,
    vatRateBps: vatBlank || vatValue === null ? null : Math.round(vatValue * 100),
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
  const [savedKey, setSavedKey] = React.useState(payloadKey);
  const dirty = payloadKey !== savedKey;

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const problems = [
    needsConversion && t('problems.convert'),
    payload.name === '' && t('problems.name'),
    !needsConversion && portions === null && t('problems.portions'),
    priceInvalid && t('problems.price'),
    !vatValid && t('problems.vat'),
    !labourBlank && !labourValid && t('problems.labour'),
    !extrasValid && t('problems.extras'),
    invalidQuantity && t('problems.quantity'),
    unavailable && t('problems.unavailable'),
  ].filter((p): p is string => typeof p === 'string');
  const canSave = problems.length === 0;

  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [leaveTo, setLeaveTo] = React.useState<string | null>(null);
  const [copying, setCopying] = React.useState(false);
  const [copyName, setCopyName] = React.useState('');
  const [copyBanner, setCopyBanner] = React.useState(justCopied);

  const backHref = initial.folderId ? `/menus/folders/${initial.folderId}` : isNew ? '/menus' : '/menus/folders/unfiled';

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

  /** Leave the editor, asking first when there are unsaved changes. */
  function leave(href: string) {
    if (dirty) setLeaveTo(href);
    else router.push(href);
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
      setCopying(false);
      if (!result.ok) return setError(actionError(result.code));
      router.push(`/menus/${result.data.id}?copied=1`);
    });
  }

  // The compact summary appears only while the pricing card is out of view.
  const firstCardRef = React.useRef<HTMLDivElement>(null);
  const [summaryPinned, setSummaryPinned] = React.useState(false);
  React.useEffect(() => {
    const el = firstCardRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setSummaryPinned(entry ? !entry.isIntersecting : false));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const dash = '—';
  const priceShown = pricing.priceExclCents !== null ? money(pricing.priceExclCents) : dash;
  const costShown = pricing.costPerPortionCents !== null ? money(pricing.costPerPortionCents) : dash;
  const leftShown = pricing.amountLeftPerPortionCents !== null ? money(pricing.amountLeftPerPortionCents) : dash;
  const marginShown = pricing.marginBps !== null ? formatPercentBps(pricing.marginBps) : dash;
  const leftNegative = pricing.amountLeftPerPortionCents !== null && pricing.amountLeftPerPortionCents < 0;
  const coversAll = portions !== null ? t('coversAll', { count: portions }) : t('coversAllUnknown');

  const actions = (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" onClick={() => leave(backHref)} disabled={pending}>
        {t('cancel')}
      </Button>
      <Button type="submit" disabled={!canSave || pending || !dirty}>
        {pending ? t('saving') : t('save')}
      </Button>
    </div>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 pb-28 md:pb-0"
    >
      {/* Header */}
      <div className="flex flex-col gap-3">
        <Link
          href={backHref}
          onClick={(e) => {
            if (!dirty) return;
            e.preventDefault();
            setLeaveTo(backHref);
          }}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t('back')}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {isNew ? t('titleCreate') : t('titleEdit')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {justSaved && !dirty && (
              <span role="status" className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
                <Check className="size-4" /> {t('saved')}
              </span>
            )}
            {dirty && <span className="text-sm text-muted-foreground">{t('unsaved')}</span>}
            {!isNew && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={dirty}
                  title={dirty ? t('copy.saveFirst') : undefined}
                  onClick={() => {
                    setCopyName(t('copy.defaultName', { name: name.trim() }));
                    setCopying(true);
                  }}
                >
                  <Copy />
                  <span className="hidden sm:inline">{t('copy.action')}</span>
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={t('delete')}>
                  <Trash2 />
                </Button>
              </>
            )}
            <div className="hidden md:block">{actions}</div>
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

      {needsConversion && (
        <Card className="border-amber-300 dark:border-amber-500/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">{t('convert.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t('convert.body', {
                amount: numberToField(initial.output.quantity),
                unit: initial.output.unit,
                price: initial.sellingPriceCents !== null ? money(initial.sellingPriceCents) : dash,
              })}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="convert-portions" label={t('portions.label')}>
                <Input
                  id="convert-portions"
                  inputMode="numeric"
                  value={convertPortionsText}
                  onChange={(e) => setConvertPortionsText(e.target.value)}
                  className="h-12 text-right text-base tabular-nums"
                />
              </Field>
              <Field id="convert-price" label={t('price.excl')}>
                <MoneyInput id="convert-price" value={convertPriceText} currency={currency} onChange={setConvertPriceText} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">{t('convert.keeps')}</p>
            <Button type="button" onClick={applyConversion} disabled={!canConvert} className="w-fit">
              {t('convert.action')}
            </Button>
          </CardContent>
        </Card>
      )}

      <div ref={firstCardRef}>
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          {/* 1. Dish name */}
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

          {/* 2. Folder + number of portions, side by side on wider screens */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-start">
            <Field id="dish-folder" label={t('fields.folder')}>
              <Select
                id="dish-folder"
                value={folderId ?? ''}
                onChange={(e) => setFolderId(e.target.value === '' ? null : e.target.value)}
                className="h-12 text-base"
              >
                <option value="">{t('fields.unfiled')}</option>
                {folders.map((f) => {
                  const path = folderAncestorLabel(folders, f.id);
                  return (
                  <option key={f.id} value={f.id}>
                    {path ? `${path} › ${f.name}` : f.name}
                  </option>
                  );
                })}
              </Select>
            </Field>
            <Field id="portions" label={t('portions.label')}>
              <Input
                id="portions"
                inputMode="numeric"
                value={portionsText}
                aria-invalid={!needsConversion && portions === null}
                aria-describedby="portions-hint"
                disabled={needsConversion}
                onChange={(e) => setPortionsText(e.target.value)}
                className="h-12 text-right text-base tabular-nums"
              />
              <p id="portions-hint" className="text-sm text-muted-foreground">
                {t('portions.hint')}
              </p>
            </Field>
          </div>

          {/* 3. Selling price excl. / incl. VAT */}
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="price-excl" label={t('price.excl')}>
                <MoneyInput
                  id="price-excl"
                  value={priceText('excl')}
                  currency={currency}
                  invalid={priceInvalid && priceDraft?.field === 'excl'}
                  disabled={needsConversion}
                  onChange={(v) => onPriceChange('excl', v)}
                  onBlur={() => setPriceDraft(null)}
                />
              </Field>
              <Field id="price-incl" label={t('price.incl')}>
                <MoneyInput
                  id="price-incl"
                  value={priceText('incl')}
                  currency={currency}
                  invalid={priceInvalid && priceDraft?.field === 'incl'}
                  disabled={needsConversion}
                  onChange={(v) => onPriceChange('incl', v)}
                  onBlur={() => setPriceDraft(null)}
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="vat-rate" className="text-sm font-normal text-muted-foreground">
                {t('price.vatRate')}
              </Label>
              <div className="relative w-24">
                <Input
                  id="vat-rate"
                  inputMode="decimal"
                  value={vatText}
                  aria-invalid={!vatValid}
                  placeholder={numberToField((defaultVatBps ?? 0) / 100)}
                  onChange={(e) => {
                    setVatText(e.target.value);
                    setPriceDraft(null);
                  }}
                  className="h-9 pr-7 text-right tabular-nums"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {vatBlank
                  ? defaultVatBps !== null
                    ? t('price.vatDefault', { rate: formatPercentBps(defaultVatBps) })
                    : t('price.vatNone')
                  : vatValid
                    ? t('price.vatOverride', { rate: formatPercentBps(vatBps) })
                    : t('problems.vat')}
              </span>
            </div>
          </div>

          {/* 4. Profit-margin calculator + live summary, in the same card */}
          <section aria-labelledby="margin-calculator" className="flex flex-col gap-4 border-t border-border pt-5">
            <div>
              <h3 id="margin-calculator" className="text-base font-semibold text-foreground">
                {t('calc.title')}
              </h3>
              <p className="text-xs text-muted-foreground">{t('calc.vatBasis')}</p>
            </div>
            <dl className="flex flex-col gap-2 text-sm">
              <Row label={t('calc.price')} value={priceShown} />
              <Row label={t('calc.costPerPortion')} value={costShown} />
              <Row label={t('calc.leftPerPortion')} value={leftShown} strong negative={leftNegative} />
              <Row label={t('calc.margin')} value={marginShown} strong negative={leftNegative} />
              <Row
                label={t('calc.totalCostPct')}
                value={pricing.totalCostBps !== null ? formatPercentBps(pricing.totalCostBps) : dash}
              />
              <Row
                label={portions !== null ? t('calc.totalCost', { count: portions }) : t('calc.totalCostUnknown')}
                value={cost.totalCostCents !== null && portions !== null ? money(cost.totalCostCents) : dash}
                divided
              />
            </dl>

            {missingReason ? (
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                {missingReason}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('calc.overheads')}</p>

            <div className="flex flex-col gap-3 rounded-xl bg-surface-2 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field id="target-margin" label={t('calc.target')}>
                  <div className="relative">
                    <Input
                      id="target-margin"
                      inputMode="decimal"
                      value={targetText}
                      placeholder="70"
                      aria-invalid={targetText.trim() !== '' && targetBps === null}
                      onChange={(e) => setTargetText(e.target.value)}
                      className="bg-surface pr-8 text-right tabular-nums"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
                  </div>
                </Field>
                <ReadOnly label={t('calc.suggestedExcl')} value={suggestedExcl !== null ? money(suggestedExcl) : dash} />
                <ReadOnly label={t('calc.suggestedIncl')} value={suggestedIncl !== null ? money(suggestedIncl) : dash} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={suggestedExcl === null || needsConversion || suggestedExcl === priceExclCents}
                  onClick={() => {
                    if (suggestedExcl === null) return;
                    setPriceExclCents(suggestedExcl);
                    setPriceDraft(null);
                  }}
                >
                  {t('calc.usePrice')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {targetText.trim() !== '' && targetBps === null
                    ? t('calc.targetInvalid')
                    : targetBps !== null && suggestedExcl === null
                      ? t('calc.suggestedNeedsCost')
                      : t('calc.targetHint')}
                </span>
              </div>
            </div>
          </section>
        </CardContent>
      </Card>
      </div>

      {/* Compact live summary — only once the pricing card has scrolled out of view. */}
      {summaryPinned && (
        <div
          aria-hidden
          className="sticky top-0 z-10 rounded-xl border border-accent-200 bg-accent-50/95 px-4 py-2.5 shadow-sm backdrop-blur dark:border-accent-800 dark:bg-accent-950/90"
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <MiniStat label={t('calc.price')} value={priceShown} />
            <MiniStat label={t('calc.costPerPortion')} value={costShown} />
            <MiniStat label={t('calc.leftPerPortion')} value={leftShown} negative={leftNegative} />
            <MiniStat label={t('calc.margin')} value={marginShown} negative={leftNegative} />
          </dl>
        </div>
      )}

      {/* 6. Recipes */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t('recipes.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{coversAll}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {recipeLines.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('recipes.empty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {recipeLines.map((line, index) => {
                const option = recipeById.get(line.recipeId);
                const contribution = lineCost.get(recipeLineKey(line.recipeId)) ?? null;
                const perKg = excludeLabour ? option?.costPerKgWithoutLabourCents : option?.costPerKgCents;
                const q = parseNumber(line.quantity);
                const remove = () => setRecipeLines((prev) => prev.filter((_, i) => i !== index));
                const hasWeight = option != null && option.yieldWeightGrams != null && option.yieldWeightGrams > 0;
                if (line.unit !== 'g') {
                  // A line saved in recipe portions: kept exactly as saved (and costed as
                  // before) until it is converted to grams or removed — never reinterpreted.
                  const saved = parseNumber(line.quantity) ?? 0;
                  const grams =
                    hasWeight && option.yieldPortions > 0
                      ? Math.round(((saved * (option.yieldWeightGrams as number)) / option.yieldPortions) * 10_000) / 10_000
                      : null;
                  return (
                    <li key={line.recipeId} className="flex flex-col gap-2 py-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <div className="flex min-w-0 basis-full flex-col gap-0.5 sm:basis-0 sm:flex-1">
                          <span className="truncate font-medium text-foreground">{line.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {t('recipes.savedPortions', { count: saved })}
                          </span>
                        </div>
                        <span className="ml-auto w-24 text-right text-sm font-medium tabular-nums text-foreground">
                          {contribution !== null ? money(contribution) : dash}
                        </span>
                        <Button type="button" variant="ghost" size="sm" aria-label={`${t('remove')} — ${line.name}`} onClick={remove}>
                          <X />
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                        <AlertTriangle className="size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1">
                          {grams !== null
                            ? t('recipes.portionLineConvertible', { grams: numberToField(grams) })
                            : t('recipes.portionLineNeedsWeight', { name: line.name })}
                        </span>
                        {grams !== null ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setRecipeLines((prev) =>
                                prev.map((l, i) => (i === index ? { ...l, quantity: numberToField(grams), unit: 'g' } : l)),
                              )
                            }
                          >
                            {t('recipes.convertToGrams', { grams: numberToField(grams) })}
                          </Button>
                        ) : option ? (
                          <Link href={`/recipes/${line.recipeId}`} className="font-medium underline underline-offset-2">
                            {t('recipes.openRecipe')}
                          </Link>
                        ) : null}
                      </div>
                    </li>
                  );
                }
                return (
                  <ComponentRow
                    key={line.recipeId}
                    name={line.name}
                    meta={
                      !option ? (
                        <Badge variant="negative">{t('unavailable')}</Badge>
                      ) : !hasWeight ? (
                        <Badge variant="warning">{t('recipes.noWeight')}</Badge>
                      ) : perKg != null ? (
                        <span>{t('recipes.perKg', { amount: money(perKg) })}</span>
                      ) : (
                        <Badge variant="warning">{t('needsPricing')}</Badge>
                      )
                    }
                    warning={option && !hasWeight ? t('recipes.needsWeight', { name: line.name }) : undefined}
                    warningHref={option && !hasWeight ? `/recipes/${line.recipeId}` : undefined}
                    warningLinkLabel={t('recipes.openRecipe')}
                    quantity={line.quantity}
                    quantityInvalid={q === null || q <= 0}
                    onQuantity={(value) => setRecipeLines((prev) => prev.map((l, i) => (i === index ? { ...l, quantity: value } : l)))}
                    unit="g"
                    units={[{ value: 'g', label: tUnits('g') }]}
                    onUnit={() => undefined}
                    contribution={contribution !== null ? money(contribution) : dash}
                    removeLabel={t('remove')}
                    onRemove={remove}
                    quantityLabel={t('recipes.grams')}
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
                return {
                  id: r.id,
                  name: r.name,
                  hint: !r.yieldWeightGrams
                    ? t('recipes.noWeight')
                    : perKg !== null
                      ? t('recipes.perKg', { amount: money(perKg) })
                      : t('needsPricing'),
                };
              })}
            onPick={(id) => {
              const option = recipeById.get(id);
              if (option) addRecipe(option);
            }}
          />
        </CardContent>
      </Card>

      {/* 7. Direct ingredients and packaging */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t('ingredients.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{coversAll}</p>
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
                    contribution={contribution !== null ? money(contribution) : dash}
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
        </CardContent>
      </Card>

      {/* 8. Labour */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t('labour.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field id="labour-hours" label={portions !== null ? t('labour.hoursFor', { count: portions }) : t('labour.hours')}>
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
            <Field id="labour-rate" label={t('labour.rate')}>
              <MoneyInput
                id="labour-rate"
                value={rateText}
                currency={currency}
                placeholder={t('optional')}
                invalid={!labourBlank && !labourValid}
                onChange={setRateText}
              />
            </Field>
            <ReadOnly
              label={t('labour.cost')}
              value={labourBlank ? t('labour.notEnteredShort') : cost.productionLabourCents !== null ? money(cost.productionLabourCents) : dash}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('labour.hint')}</p>
          {!labourBlank && !labourValid && <p className="text-sm text-red-700 dark:text-red-300">{t('problems.labour')}</p>}
          {labourValid && <Notice tone="info">{t('labour.replacesRecipeLabour')}</Notice>}
          {labourBlank && (
            <Notice tone="info">{cost.inheritsRecipeLabour ? t('labour.legacy') : t('labour.notEntered')}</Notice>
          )}
        </CardContent>
      </Card>

      {/* 9. Extra costs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t('extras.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('extras.reminder')}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {extras.length > 0 && (
            <ul className="flex flex-col gap-3">
              {extras.map((extra, index) => {
                const v = extraValues[index];
                const amount =
                  v?.kind === 'work'
                    ? Number.isFinite(v.hours) && Number.isFinite(v.hourlyCents)
                      ? money(Math.round(v.hours * v.hourlyCents))
                      : dash
                    : v && Number.isFinite(v.amountCents)
                      ? money(v.amountCents)
                      : dash;
                return (
                  <li key={extra.key} className="flex flex-wrap items-end gap-2 rounded-xl border border-border p-3">
                    <Field
                      id={`extra-desc-${extra.key}`}
                      label={extra.kind === 'work' ? t('extras.workLabel') : t('extras.expenseLabel')}
                      className="min-w-40 flex-1"
                    >
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
        </CardContent>
      </Card>

      {/* Notes stay available, after the calculator flow. */}
      <Card>
        <CardContent className="pt-6">
          <Field id="dish-notes" label={t('fields.notes')}>
            <Textarea
              id="dish-notes"
              value={notes}
              maxLength={1000}
              placeholder={t('fields.notesPlaceholder')}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      {!canSave && (dirty || !isNew) && (
        <ul className="flex flex-col gap-1 text-sm text-red-700 dark:text-red-300">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="hidden justify-end md:flex">{actions}</div>

      {/* Mobile: margin + Save / Cancel always in reach. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur md:hidden">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm">
            <span className="text-muted-foreground">{t('calc.margin')}: </span>
            <span className={cn('font-semibold tabular-nums', leftNegative && 'text-red-700 dark:text-red-300')}>{marginShown}</span>
          </span>
          {actions}
        </div>
      </div>

      <ConfirmDialog
        open={leaveTo !== null}
        title={t('discard.title')}
        description={t('discard.body')}
        confirmLabel={t('discard.confirm')}
        cancelLabel={t('discard.keep')}
        destructive
        onConfirm={() => {
          const href = leaveTo;
          setLeaveTo(null);
          setSavedKey(payloadKey);
          if (href) router.push(href);
        }}
        onCancel={() => setLeaveTo(null)}
      />

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
        <Input
          value={copyName}
          maxLength={200}
          autoFocus
          aria-label={t('fields.name')}
          onChange={(e) => setCopyName(e.target.value)}
          className="mt-2 h-12"
        />
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

function Field({ id, label, children, className }: { id: string; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function MoneyInput({
  id,
  value,
  currency,
  onChange,
  onBlur,
  invalid,
  disabled,
  placeholder = '0.00',
}: {
  id: string;
  value: string;
  currency: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="h-12 pr-14 text-right text-base tabular-nums"
      />
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        {currency}
      </span>
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="flex h-12 items-center justify-end rounded-lg bg-surface px-3 text-base font-semibold tabular-nums ring-1 ring-border">
        {value}
      </span>
    </div>
  );
}

function MiniStat({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:gap-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('text-sm font-semibold tabular-nums', negative ? 'text-red-700 dark:text-red-300' : 'text-foreground')}>
        {value}
      </dd>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  negative,
  divided,
}: {
  label: string;
  value: string;
  strong?: boolean;
  negative?: boolean;
  divided?: boolean;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-2', divided && 'border-t border-border pt-2')}>
      <dt className={cn(strong ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</dt>
      <dd
        className={cn(
          'text-right tabular-nums',
          strong ? 'font-display text-xl font-semibold' : 'font-medium',
          negative ? 'text-red-700 dark:text-red-300' : 'text-foreground',
        )}
      >
        {value}
      </dd>
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
        tone === 'info' ? 'bg-surface-2 text-foreground' : 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
      )}
    >
      {tone === 'info' ? <Info className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

function ComponentRow({
  name,
  meta,
  warning,
  warningHref,
  warningLinkLabel,
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
  warningHref?: string;
  warningLinkLabel?: string;
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
        {warning && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            {warning}
            {warningHref && (
              <>
                {' '}
                <Link href={warningHref} className="font-medium underline underline-offset-2">
                  {warningLinkLabel}
                </Link>
              </>
            )}
          </span>
        )}
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
        {units.length === 1 ? (
          <span className="flex h-11 items-center px-1 text-sm text-muted-foreground">{units[0]?.label}</span>
        ) : (
          <Select value={unit} aria-label={`${unitLabel} — ${name}`} onChange={(e) => onUnit(e.target.value)} className="h-11">
            {units.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </Select>
        )}
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
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
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
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">{emptyLabel}</li>
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
