'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Copy, Folder, Info, Plus, Trash2, X } from 'lucide-react';
import {
  compositionCost,
  dishResults,
  ingredientLineKey,
  outputKind,
  priceExclVat,
  priceForIngredientMargin,
  priceInclVat,
  recipeLineKey,
  roundHours,
  type DishComposition,
  type DishCostKind,
  type DishCostLookups,
  type DishExtra,
  type DishIngredientUnit,
  type DishOutputUnit,
} from '@/lib/calculations/dish';
import type {
  DishExtraView,
  DishIngredientOption,
  DishOutputView,
  DishRecipeOption,
  KitchenDishIngredientLine,
  KitchenDishRecipeLine,
} from '@/lib/data/menus';
import type { Dimension } from '@/lib/units';
import type { WeightDisplayUnit } from '@/lib/format/weight';
import { centsToAmountInput, formatMoney } from '@/lib/format/money';
import { folderAncestorLabel } from '@/lib/folders/tree';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  canonicalToField,
  canonicalToUnitAmount,
  fieldToCanonical,
  lineDisplayUnit,
  parseDecimal,
  parseMoneyText,
  parsePercentBps,
  roundCanonical,
} from '@/lib/menus/dish-editor';
import {
  createDishAction,
  deleteMenuAction,
  duplicateDishAction,
  markDishOpenedAction,
  updateDishAction,
} from '@/app/(app)/menus/actions';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { InfoPopover } from '@/components/app/recipes/workspace/info-popover';
import { cn } from '@/lib/utils';
import { UnitSwitch } from '@/components/app/recipes/editor/unit-switch';
import { useLeaveGuard } from '@/components/app/recipes/editor/use-leave-guard';
import { numberToField } from './dish-format';
import { CostKindToggle, Field, LineRow, MoneyInput, OverflowMenu, OverflowMenuItem } from './dish-builder-parts';
import { DishPricingPanel } from './dish-pricing-panel';
import { DishSearch } from './dish-search';

export type DishBuilderInitial = {
  id: string | null;
  name: string;
  folderId: string | null;
  output: DishOutputView;
  sellingPriceCents: number | null;
  vatRateBps: number | null;
  displayUnit: WeightDisplayUnit;
  labour: { hours: number; hourlyCents: number } | null;
  extras: DishExtraView[];
  notes: string | null;
  recipeLines: KitchenDishRecipeLine[];
  ingredientLines: KitchenDishIngredientLine[];
};

/** `amount` is canonical: grams for gram lines, recipe portions for a legacy portion line. */
type RecipeLineState = { recipeId: string; name: string; unit: 'g' | 'portion'; amount: number | null; draft: string | null };
/** `amount` is canonical (g / ml / count); `storedUnit` keeps ml vs l and is never reinterpreted as weight. */
type IngredientLineState = {
  ingredientId: string;
  name: string;
  dimension: Dimension;
  storedUnit: DishIngredientUnit;
  amount: number | null;
  draft: string | null;
  costKind: DishCostKind | null;
};
type ExtraState = { key: string; kind: 'work' | 'expense'; description: string; hours: string; rate: string; amount: string };

/** Saleable items are whole numbers; the same upper bound the batch output had. */
const MAX_ITEMS = 100_000;
const DASH = '—';

const UNIT_DIMENSION: Record<DishIngredientUnit, Dimension> = { g: 'weight', kg: 'weight', ml: 'volume', l: 'volume', piece: 'count' };

function parseItems(text: string): number | null {
  const value = parseDecimal(text);
  return value !== null && Number.isInteger(value) && value >= 1 && value <= MAX_ITEMS ? value : null;
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
 * The Menu dish editor. Order: name; folder + "These quantities make [n] [items]";
 * recipes and direct ingredients (one shared g/kg switch); labour; extra costs;
 * selling price with the three results; the target ingredient margin calculator;
 * optional notes. One Save dish action, a quieter Cancel.
 *
 * Every quantity, hour and cost on the page covers ALL the items entered: the item
 * count only spreads the same costs, it never rescales a quantity or an hour. Figures
 * come from the shared `compositionCost` + `dishResults` — the same maths the Menu
 * list, sales and insights use. Unentered labour and unknown prices are shown as
 * missing, never as a confirmed zero, and a draft can still be saved.
 *
 * A product saved earlier as a WEIGHT batch (priced per kg) is never reinterpreted:
 * the editor asks for its items and a price per item first.
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
  /** Count products keep their stored unit (piece / cake / portion); weight batches become portions. */
  const countUnit: DishOutputUnit = legacyWeight ? 'portion' : initial.output.unit;

  const [name, setName] = React.useState(initial.name);
  const [folderId, setFolderId] = React.useState(initial.folderId);
  const [notes, setNotes] = React.useState(initial.notes ?? '');
  const [itemsText, setItemsText] = React.useState(
    legacyWeight ? '' : initial.output.quantity > 0 ? numberToField(initial.output.quantity) : '1',
  );
  const [labelText, setLabelText] = React.useState(initial.output.label ?? '');
  const [displayUnit, setDisplayUnit] = React.useState<WeightDisplayUnit>(initial.displayUnit);
  const [priceExclCents, setPriceExclCents] = React.useState(legacyWeight ? null : initial.sellingPriceCents);
  const [priceDraft, setPriceDraft] = React.useState<{ field: 'excl' | 'incl'; text: string } | null>(null);
  const [vatText, setVatText] = React.useState(initial.vatRateBps !== null ? numberToField(initial.vatRateBps / 100) : '');
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
  // Recipe components are entered by weight. Older kilogram lines convert exactly to
  // grams; recipe-portion lines stay as saved until corrected (see the recipes list).
  const [recipeLines, setRecipeLines] = React.useState<RecipeLineState[]>(() =>
    initial.recipeLines.map((l) => ({
      recipeId: l.recipeId,
      name: l.recipeName,
      unit: l.unit === 'portion' ? ('portion' as const) : ('g' as const),
      amount: l.unit === 'kg' ? roundCanonical(l.quantity * 1000) : l.quantity,
      draft: null,
    })),
  );
  const [ingredientLines, setIngredientLines] = React.useState<IngredientLineState[]>(() =>
    initial.ingredientLines.map((l) => {
      const option = ingredientById.get(l.ingredientId);
      const factor = l.unit === 'kg' || l.unit === 'l' ? 1000 : 1;
      return {
        ingredientId: l.ingredientId,
        name: l.ingredientName,
        dimension: option?.dimension ?? UNIT_DIMENSION[l.unit],
        storedUnit: l.unit,
        // The loader returns the amount in the saved unit; keep it canonical here.
        amount: roundCanonical(l.quantity * factor),
        draft: null,
        costKind: option?.costKind ?? null,
      };
    }),
  );

  React.useEffect(() => {
    if (initial.id) void markDishOpenedAction(initial.id);
  }, [initial.id]);

  // ── Items + VAT ───────────────────────────────────────────────────────────
  const items = parseItems(itemsText);
  const vatBlank = vatText.trim() === '';
  const vatParsed = parsePercentBps(vatText);
  const vatValid = vatBlank || (vatParsed !== null && vatParsed >= 0 && vatParsed <= 10_000);
  const vatBps = vatBlank || !vatValid || vatParsed === null ? (defaultVatBps ?? 0) : vatParsed;
  const label = labelText.trim();
  const itemPlural = label !== '' ? label : t('output.labelPlaceholder', { unit: countUnit });
  const itemSingular = label !== '' ? label : t('output.singular', { unit: countUnit });

  // ── Labour + extras ───────────────────────────────────────────────────────
  const hours = parseDecimal(hoursText);
  const rate = parseMoneyText(rateText);
  const labourBlank = hoursText.trim() === '' && rateText.trim() === '';
  const labourValid =
    !labourBlank && hours !== null && hours <= 100_000 && rate !== null && Number.isFinite(rate) && rate >= 0;
  const labour: DishComposition['labour'] = labourBlank
    ? null
    : labourValid
      ? { hours: roundHours(hours as number), hourlyCents: rate as number }
      : { hours: Number.NaN, hourlyCents: Number.NaN };

  const extraValues: DishExtra[] = extras.map((e) => {
    if (e.kind === 'work') {
      const h = parseDecimal(e.hours);
      const r = parseMoneyText(e.rate);
      return {
        kind: 'work',
        hours: h === null ? Number.NaN : roundHours(h),
        hourlyCents: r === null || !Number.isFinite(r) ? Number.NaN : r,
      };
    }
    const a = parseMoneyText(e.amount);
    return { kind: 'expense', amountCents: a === null || !Number.isFinite(a) ? Number.NaN : a };
  });
  const extraValid = (i: number) => {
    const v = extraValues[i];
    return v?.kind === 'work' ? Number.isFinite(v.hours) && Number.isFinite(v.hourlyCents) : v?.kind === 'expense' && Number.isFinite(v.amountCents);
  };
  const extrasValid = extras.every((e, i) => e.description.trim() !== '' && extraValid(i));
  const extrasTotalCents = extraValues.reduce((sum, v, i) => {
    if (!extraValid(i)) return sum;
    return sum + (v.kind === 'work' ? Math.round(v.hours * v.hourlyCents) : v.amountCents);
  }, 0);

  // ── Cost + results ────────────────────────────────────────────────────────
  const lineUnit = (l: IngredientLineState) => lineDisplayUnit(l.dimension, l.storedUnit, displayUnit);
  const kindById = new Map(ingredientLines.map((l) => [l.ingredientId, l.costKind]));
  const lookups: DishCostLookups = {
    recipe: (id) => {
      const r = recipeById.get(id);
      return r ? { yieldPortions: r.yieldPortions, yieldWeightGrams: r.yieldWeightGrams, ingredientCostCents: r.ingredientCostCents } : null;
    },
    ingredient: (id) => {
      const i = ingredientById.get(id);
      return i ? { dimension: i.dimension, priceCents: i.priceCents, needsPricing: i.needsPricing, costKind: kindById.get(id) ?? null } : null;
    },
  };
  const cost = compositionCost(
    {
      // Items are the sale units; the finished weight plays no part in the price.
      output: { quantity: items ?? 0, unit: countUnit, finishedWeightGrams: null },
      labour,
      extras: extraValues,
      recipeLines: recipeLines.map((l) => ({ recipeId: l.recipeId, quantity: l.amount ?? 0, unit: l.unit })),
      ingredientLines: ingredientLines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.amount ?? 0, unit: lineUnit(l) })),
    },
    lookups,
  );
  const lineCost = new Map(cost.lineCosts.map((l) => [l.key, l.costCents]));
  const results = dishResults(cost, priceExclCents, vatBps);

  const targetBlank = targetText.trim() === '';
  const targetParsed = parsePercentBps(targetText);
  const targetBps = targetParsed !== null && targetParsed >= 0 && targetParsed < 10_000 ? targetParsed : null;
  const targetInvalid = !targetBlank && targetBps === null;
  const suggestedExcl = targetBps !== null ? priceForIngredientMargin(results.exactFoodCostPerItemCents, targetBps) : null;
  const suggestedIncl = suggestedExcl !== null ? priceInclVat(suggestedExcl, vatBps) : null;
  const coverNote =
    suggestedExcl === null
      ? null
      : results.exactTotalCostPerItemCents !== null
        ? suggestedExcl < results.exactTotalCostPerItemCents
          ? {
              tone: 'warning' as const,
              text: t('target.notCovering', {
                price: money(suggestedExcl),
                cost: money(Math.round(results.exactTotalCostPerItemCents)),
              }),
            }
          : null
        : { tone: 'muted' as const, text: cost.labourEntered ? t('target.coverUnknown') : t('target.coverNeedsLabour') };

  function priceText(field: 'excl' | 'incl'): string {
    if (priceDraft?.field === field) return priceDraft.text;
    const cents = field === 'excl' ? results.priceExclCents : results.priceInclCents;
    return cents !== null ? centsToAmountInput(cents) : '';
  }
  function onPriceChange(field: 'excl' | 'incl', text: string) {
    setPriceDraft({ field, text });
    const cents = parseMoneyText(text);
    if (cents === null) setPriceExclCents(null);
    else if (Number.isFinite(cents)) setPriceExclCents(field === 'excl' ? cents : priceExclVat(cents, vatBps));
  }
  const priceInvalid = priceDraft !== null && !Number.isFinite(parseMoneyText(priceDraft.text) ?? 0);

  // ── Focus (picked rows, Enter, remove) ────────────────────────────────────
  const quantityRefs = React.useRef(new Map<string, HTMLInputElement>());
  const recipeSearchRef = React.useRef<HTMLInputElement>(null);
  const ingredientSearchRef = React.useRef<HTMLInputElement>(null);
  const hoursRef = React.useRef<HTMLInputElement>(null);
  const pendingFocus = React.useRef<string | null>(null);
  const registerQuantity = (key: string) => (el: HTMLInputElement | null) => {
    if (el) quantityRefs.current.set(key, el);
    else quantityRefs.current.delete(key);
  };
  const focusQuantity = (key: string) => {
    const el = quantityRefs.current.get(key);
    el?.focus();
    el?.select();
  };
  React.useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    focusQuantity(key);
  });

  function pickRecipe(id: string) {
    const option = recipeById.get(id);
    if (!option) return;
    const key = recipeLineKey(id);
    if (recipeLines.some((l) => l.recipeId === id)) return focusQuantity(key);
    // No default weight: the chef types it, so nothing is costed from a guess.
    setRecipeLines((prev) => [...prev, { recipeId: id, name: option.name, unit: 'g', amount: null, draft: '' }]);
    pendingFocus.current = key;
  }
  function pickIngredient(id: string) {
    const option = ingredientById.get(id);
    if (!option) return;
    const key = ingredientLineKey(id);
    if (ingredientLines.some((l) => l.ingredientId === id)) return focusQuantity(key);
    setIngredientLines((prev) => [
      ...prev,
      {
        ingredientId: id,
        name: option.name,
        dimension: option.dimension,
        storedUnit: option.dimension === 'weight' ? displayUnit : option.dimension === 'volume' ? 'ml' : 'piece',
        amount: null,
        draft: '',
        costKind: option.costKind,
      },
    ]);
    pendingFocus.current = key;
  }

  function changeDisplayUnit(next: WeightDisplayUnit) {
    if (next === displayUnit) return;
    setDisplayUnit(next);
    // Quantities are canonical: re-render readable weights in the new unit. An
    // unreadable draft is left as typed so nothing the chef entered disappears.
    setRecipeLines((prev) => prev.map((l) => (l.unit === 'g' && l.amount !== null ? { ...l, draft: null } : l)));
    setIngredientLines((prev) => prev.map((l) => (l.dimension === 'weight' && l.amount !== null ? { ...l, draft: null } : l)));
  }

  const patchExtra = (key: string, patch: Partial<ExtraState>) =>
    setExtras((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  // ── Weight batch → items (explicit and lossless) ──────────────────────────
  const [convertItemsText, setConvertItemsText] = React.useState('');
  const [convertPriceText, setConvertPriceText] = React.useState('');
  const convertItems = parseItems(convertItemsText);
  const convertPrice = parseMoneyText(convertPriceText);
  const canConvert = convertItems !== null && (convertPrice === null || Number.isFinite(convertPrice));
  function applyConversion() {
    if (!canConvert || convertItems === null) return;
    const grams = initial.output.unit === 'kg' ? initial.output.quantity * 1000 : initial.output.quantity;
    setConvertedGrams(grams);
    setItemsText(String(convertItems));
    setPriceExclCents(convertPrice);
    setPriceDraft(null);
  }

  // ── Save / dirty ──────────────────────────────────────────────────────────
  const unavailable =
    recipeLines.some((l) => !recipeById.has(l.recipeId)) || ingredientLines.some((l) => !ingredientById.has(l.ingredientId));
  const invalidQuantity = [...recipeLines, ...ingredientLines].some((l) => l.amount === null || l.amount <= 0);

  const payload = {
    name: name.trim(),
    folderId,
    output: {
      quantity: items ?? 0,
      unit: countUnit,
      // Kept exactly as stored. A converted weight batch keeps its weight here.
      sizeDescription: initial.output.sizeDescription,
      label: label === '' ? null : label,
      finishedWeightGrams: legacyWeight ? convertedGrams : initial.output.finishedWeightGrams,
    },
    sellingPriceCents: priceExclCents,
    priceBasis: 'unit' as const,
    vatRateBps: vatBlank || vatParsed === null ? null : vatParsed,
    displayUnit,
    labour: labourValid ? labour : null,
    extras: extras.map((e, i) => {
      const v = extraValues[i] as DishExtra;
      return v.kind === 'work'
        ? { kind: 'work' as const, description: e.description.trim(), hours: v.hours, hourlyCents: v.hourlyCents }
        : { kind: 'expense' as const, description: e.description.trim(), amountCents: v.amountCents };
    }),
    notes: notes.trim() === '' ? null : notes.trim(),
    recipeLines: recipeLines.map((l) => ({ recipeId: l.recipeId, quantity: l.amount ?? 0, unit: l.unit })),
    ingredientLines: ingredientLines.map((l) => {
      const unit = lineUnit(l);
      return {
        ingredientId: l.ingredientId,
        quantity: l.amount === null ? 0 : canonicalToUnitAmount(l.amount, unit),
        unit,
        costKind: l.costKind,
      };
    }),
  };
  const payloadKey = JSON.stringify(payload);
  const [savedKey, setSavedKey] = React.useState(payloadKey);
  const dirty = payloadKey !== savedKey;

  const problems = [
    needsConversion && t('problems.convert'),
    payload.name === '' && t('problems.name'),
    !needsConversion && items === null && t('problems.items'),
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
  const [showProblems, setShowProblems] = React.useState(false);
  const problemsRef = React.useRef<HTMLUListElement>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [leaveTo, setLeaveTo] = React.useState<string | null>(null);
  const [copying, setCopying] = React.useState(false);
  const [copyName, setCopyName] = React.useState('');
  const [copyBanner, setCopyBanner] = React.useState(justCopied);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [extrasOpen, setExtrasOpen] = React.useState(false);
  const [notesOpen, setNotesOpen] = React.useState(notes.trim() !== '');

  useLeaveGuard(dirty && !pending, (href) => setLeaveTo(href));

  const cancelHref = initial.folderId ? `/menus/folders/${initial.folderId}` : isNew ? '/menus' : '/menus/folders/unfiled';

  function save() {
    if (pending) return;
    if (!canSave) {
      setShowProblems(true);
      window.requestAnimationFrame(() => problemsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      return;
    }
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
      setShowProblems(false);
      router.refresh();
    });
  }

  // Ctrl/Cmd+S saves from anywhere in the form.
  const saveRef = React.useRef(save);
  saveRef.current = save;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function cancel() {
    if (dirty) setLeaveTo(cancelHref);
    else router.push(cancelHref);
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

  function focusLabour() {
    hoursRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    hoursRef.current?.focus({ preventScroll: true });
  }

  // ── Why some results are blank ────────────────────────────────────────────
  const hasComponents = recipeLines.length + ingredientLines.length > 0;
  const unknownCostCount = cost.incompleteKeys.filter((k) => k.startsWith('r:') || k.startsWith('i:')).length;
  const missing: { key: string; text: string; action?: { label: string; onClick: () => void } }[] = [];
  if (needsConversion) missing.push({ key: 'convert', text: t('results.missing.convert') });
  else {
    if (items === null) missing.push({ key: 'items', text: t('results.missing.items') });
    if (!hasComponents) missing.push({ key: 'costs', text: t('results.missing.costs') });
    if (results.priceExclCents === null || results.priceExclCents <= 0) missing.push({ key: 'price', text: t('results.missing.price') });
    if (unknownCostCount > 0) missing.push({ key: 'unknown', text: t('results.missing.unknownCost', { count: unknownCostCount }) });
    if (cost.unclassifiedKeys.length > 0) {
      missing.push({ key: 'unclassified', text: t('results.missing.unclassified', { count: cost.unclassifiedKeys.length }) });
    }
    if ((!labourBlank && !labourValid) || !extrasValid) missing.push({ key: 'invalid', text: t('results.missing.invalid') });
    else if (labourBlank) {
      missing.push({ key: 'labour', text: t('results.missing.labour'), action: { label: t('results.missing.labourAction'), onClick: focusLabour } });
    } else if (cost.workHours === 0) missing.push({ key: 'hours', text: t('results.missing.noHours') });
    if (hasComponents && !cost.hasFoodLines && cost.unclassifiedKeys.length === 0) {
      missing.push({ key: 'food', text: t('results.missing.noFood') });
    }
  }

  const extraHours = cost.extraWorkHours ?? 0;
  const extrasStatus = extras.length === 0 ? t('extras.none') : extrasValid ? money(extrasTotalCents) : DASH;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 pb-10"
    >
      {/* ── Action bar: stays reachable while the form scrolls ─────────────── */}
      <div className="sticky -top-4 z-20 -mx-4 flex items-center justify-between gap-3 bg-background/95 px-4 py-3 backdrop-blur md:-top-6 lg:-top-8">
        <h1 className="truncate text-sm font-medium text-muted-foreground">{isNew ? t('newTitle') : t('editTitle')}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {justSaved && !dirty ? (
            <span role="status" className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
              <Check className="size-4" />
              <span className="hidden sm:inline">{t('saved')}</span>
            </span>
          ) : null}
          {dirty ? <span className="hidden text-sm text-muted-foreground md:inline">{t('unsaved')}</span> : null}
          <Button type="button" variant="ghost" onClick={cancel} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={pending || (!dirty && !isNew)} className="min-w-32">
            {pending ? t('saving') : t('save')}
          </Button>
          {!isNew ? (
            <OverflowMenu open={menuOpen} onOpenChange={setMenuOpen} label={t('overflow.label')}>
              <OverflowMenuItem
                disabled={dirty}
                title={dirty ? t('copy.saveFirst') : undefined}
                onClick={() => {
                  setMenuOpen(false);
                  setCopyName(t('copy.defaultName', { name: name.trim() }));
                  setCopying(true);
                }}
              >
                <Copy className="size-4" />
                {t('copy.action')}
              </OverflowMenuItem>
              <OverflowMenuItem
                destructive
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDelete(true);
                }}
              >
                <Trash2 className="size-4" />
                {t('delete')}
              </OverflowMenuItem>
            </OverflowMenu>
          ) : null}
        </div>
      </div>

      {copyBanner ? (
        <div className="flex items-start gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm text-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="flex-1">{t('copy.banner')}</span>
          <button type="button" onClick={() => setCopyBanner(false)} aria-label={t('dismiss')} className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
          {error}
        </p>
      ) : null}
      {showProblems && problems.length > 0 ? (
        <ul ref={problemsRef} role="alert" className="flex flex-col gap-1 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-300">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

      {needsConversion ? (
        <Card className="border-amber-300 dark:border-amber-500/40">
          <CardContent className="flex flex-col gap-4 p-5 sm:p-7">
            <h2 className="text-lg font-semibold text-foreground">{t('convert.title')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('convert.body', {
                amount: numberToField(initial.output.quantity),
                unit: initial.output.unit,
                price: initial.sellingPriceCents !== null ? money(initial.sellingPriceCents) : DASH,
              })}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="convert-items" label={t('output.count')}>
                <Input
                  id="convert-items"
                  inputMode="numeric"
                  value={convertItemsText}
                  onChange={(e) => setConvertItemsText(e.target.value)}
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
      ) : null}

      {/* ── Name, folder + items, recipes, direct ingredients ───────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-6 p-5 sm:p-7">
          <div className="flex flex-col gap-3">
            <Label htmlFor="dish-name" className="sr-only">
              {t('fields.name')}
            </Label>
            <input
              id="dish-name"
              value={name}
              maxLength={200}
              autoComplete="off"
              autoFocus={isNew || justCopied}
              placeholder={t('fields.namePlaceholder')}
              aria-invalid={showProblems && payload.name === ''}
              onChange={(e) => setName(e.target.value)}
              className="h-14 w-full rounded-xl border border-border bg-surface px-4 font-display text-2xl font-semibold tracking-tight text-foreground transition-colors placeholder:font-normal placeholder:text-muted-foreground/60 hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-16 sm:text-[28px] aria-[invalid=true]:border-red-500"
            />
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <div className="flex min-w-0 items-center gap-1.5">
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Label htmlFor="dish-folder" className="sr-only">
                  {t('fields.folder')}
                </Label>
                <Select
                  id="dish-folder"
                  value={folderId ?? ''}
                  onChange={(e) => setFolderId(e.target.value === '' ? null : e.target.value)}
                  className="h-10 max-w-60 border-none bg-transparent px-1.5 text-sm text-muted-foreground shadow-none hover:text-foreground"
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
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{t('output.prefix')}</span>
                <Input
                  id="dish-items"
                  inputMode="numeric"
                  value={itemsText}
                  aria-label={t('output.count')}
                  aria-invalid={!needsConversion && items === null}
                  disabled={needsConversion}
                  onChange={(e) => setItemsText(e.target.value)}
                  className="h-10 w-20 text-right text-base tabular-nums"
                />
                <Input
                  id="dish-item-label"
                  value={labelText}
                  maxLength={40}
                  aria-label={t('output.label')}
                  placeholder={t('output.labelPlaceholder', { unit: countUnit })}
                  onChange={(e) => setLabelText(e.target.value)}
                  className="h-10 w-36 text-base"
                />
                <InfoPopover label={t('infoLabel', { topic: t('output.topic') })}>{t('output.info')}</InfoPopover>
              </div>
            </div>
          </div>

          {/* Recipes — the g/kg switch here controls weights in both lists. */}
          <section aria-labelledby="dish-recipes-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="dish-recipes-heading" className="flex items-center gap-1.5 text-lg font-semibold text-foreground">
                {t('recipes.title')}
                <InfoPopover label={t('infoLabel', { topic: t('recipes.topic') })}>{t('recipes.info')}</InfoPopover>
              </h2>
              <UnitSwitch value={displayUnit} onChange={changeDisplayUnit} label={t('unitSwitch')} />
            </div>
            {recipeLines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
                {t('recipes.empty')}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {recipeLines.map((line, index) => {
                  const option = recipeById.get(line.recipeId);
                  const key = recipeLineKey(line.recipeId);
                  const contribution = lineCost.get(key) ?? null;
                  const removeLine = () => {
                    setRecipeLines((prev) => prev.filter((_, i) => i !== index));
                    recipeSearchRef.current?.focus();
                  };
                  const hasWeight = option != null && option.yieldWeightGrams != null && option.yieldWeightGrams > 0;
                  if (line.unit === 'portion') {
                    // Saved in recipe portions: kept and costed as saved until converted or
                    // removed — never reinterpreted.
                    const saved = line.amount ?? 0;
                    const grams =
                      hasWeight && option.yieldPortions > 0
                        ? roundCanonical((saved * (option.yieldWeightGrams as number)) / option.yieldPortions)
                        : null;
                    return (
                      <li key={key} className="flex flex-col gap-2 py-3">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <div className="flex min-w-0 basis-full flex-col gap-0.5 sm:basis-0 sm:flex-1">
                            <span className="truncate text-[17px] font-semibold text-foreground">{line.name}</span>
                            <span className="text-xs text-muted-foreground">{t('recipes.savedPortions', { count: saved })}</span>
                          </div>
                          <span className="ml-auto w-20 text-right text-sm tabular-nums text-muted-foreground">
                            {contribution !== null ? money(contribution) : DASH}
                          </span>
                          <Button type="button" variant="ghost" aria-label={t('removeItem', { name: line.name })} onClick={removeLine} className="size-10 p-0">
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
                                setRecipeLines((prev) => prev.map((l, i) => (i === index ? { ...l, unit: 'g', amount: grams, draft: null } : l)))
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
                    <LineRow
                      key={key}
                      name={line.name}
                      meta={
                        !option ? (
                          <Badge variant="negative">{t('unavailable')}</Badge>
                        ) : !hasWeight ? (
                          <Badge variant="warning">{t('recipes.noWeight')}</Badge>
                        ) : option.ingredientCostPerKgCents !== null ? (
                          <span className="tabular-nums">{t('recipes.perKg', { amount: money(option.ingredientCostPerKgCents) })}</span>
                        ) : (
                          <Badge variant="warning">{t('needsPricing')}</Badge>
                        )
                      }
                      footer={
                        option && !hasWeight ? (
                          <p className="text-xs text-amber-700 dark:text-amber-300">
                            {t('recipes.needsWeight', { name: line.name })}{' '}
                            <Link href={`/recipes/${line.recipeId}`} className="font-medium underline underline-offset-2">
                              {t('recipes.openRecipe')}
                            </Link>
                          </p>
                        ) : option && option.legacyExtraCostCents > 0 ? (
                          <p className="text-xs text-muted-foreground">{t('recipes.legacyCosts')}</p>
                        ) : null
                      }
                      quantity={line.draft ?? (line.amount !== null ? canonicalToField(line.amount, displayUnit) : '')}
                      quantityInvalid={line.draft !== null && line.draft.trim() !== '' && line.amount === null}
                      quantityLabel={t('quantityFor', { name: line.name, unit: tUnits(displayUnit) })}
                      unitLabel={tUnits(displayUnit)}
                      onQuantity={(text) =>
                        setRecipeLines((prev) =>
                          prev.map((l, i) => (i === index ? { ...l, draft: text, amount: fieldToCanonical(text, displayUnit) } : l)),
                        )
                      }
                      onQuantityBlur={() =>
                        setRecipeLines((prev) => prev.map((l, i) => (i === index && l.amount !== null ? { ...l, draft: null } : l)))
                      }
                      onQuantityEnter={() => recipeSearchRef.current?.focus()}
                      quantityRef={registerQuantity(key)}
                      cost={contribution !== null ? money(contribution) : DASH}
                      removeLabel={t('removeItem', { name: line.name })}
                      onRemove={removeLine}
                    />
                  );
                })}
              </ul>
            )}
            <DishSearch
              ref={recipeSearchRef}
              options={recipeOptions.map((r) => ({
                id: r.id,
                name: r.name,
                hint:
                  r.ingredientCostPerKgCents !== null
                    ? t('recipes.perKg', { amount: money(r.ingredientCostPerKgCents) })
                    : !r.yieldWeightGrams
                      ? t('recipes.noWeight')
                      : t('needsPricing'),
              }))}
              usedIds={new Set(recipeLines.map((l) => l.recipeId))}
              placeholder={t('recipes.search')}
              label={t('recipes.searchLabel')}
              noMatches={(query) => t('noMatches', { query })}
              addedLabel={t('added')}
              onPick={pickRecipe}
            />
          </section>

          {/* Direct ingredients — food and packaging, explicitly classified. */}
          <section aria-labelledby="dish-ingredients-heading" className="flex flex-col gap-3 border-t border-border pt-6">
            <h2 id="dish-ingredients-heading" className="flex items-center gap-1.5 text-lg font-semibold text-foreground">
              {t('ingredients.title')}
              <InfoPopover label={t('infoLabel', { topic: t('ingredients.topic') })}>{t('ingredients.info')}</InfoPopover>
            </h2>
            {ingredientLines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
                {t('ingredients.empty')}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {ingredientLines.map((line, index) => {
                  const option = ingredientById.get(line.ingredientId);
                  const key = ingredientLineKey(line.ingredientId);
                  const contribution = lineCost.get(key) ?? null;
                  const unit = lineUnit(line);
                  return (
                    <LineRow
                      key={key}
                      name={line.name}
                      meta={
                        <>
                          {!option ? (
                            <Badge variant="negative">{t('unavailable')}</Badge>
                          ) : option.needsPricing ? (
                            <Badge variant="warning">{t('needsPricing')}</Badge>
                          ) : (
                            <span className="tabular-nums">{t(`ingredients.per.${option.dimension}`, { amount: money(option.priceCents) })}</span>
                          )}
                          {option ? (
                            <CostKindToggle
                              value={line.costKind}
                              name={line.name}
                              onChange={(costKind) =>
                                setIngredientLines((prev) => prev.map((l, i) => (i === index ? { ...l, costKind } : l)))
                              }
                              labels={{
                                group: t('ingredients.kindLabel'),
                                food: t('ingredients.food'),
                                packaging: t('ingredients.packaging'),
                                missing: t('ingredients.kindMissing'),
                              }}
                            />
                          ) : null}
                        </>
                      }
                      quantity={line.draft ?? (line.amount !== null ? canonicalToField(line.amount, unit) : '')}
                      quantityInvalid={line.draft !== null && line.draft.trim() !== '' && line.amount === null}
                      quantityLabel={t('quantityFor', { name: line.name, unit: tUnits(unit) })}
                      unitLabel={tUnits(unit)}
                      onQuantity={(text) =>
                        setIngredientLines((prev) =>
                          prev.map((l, i) => (i === index ? { ...l, draft: text, amount: fieldToCanonical(text, unit) } : l)),
                        )
                      }
                      onQuantityBlur={() =>
                        setIngredientLines((prev) => prev.map((l, i) => (i === index && l.amount !== null ? { ...l, draft: null } : l)))
                      }
                      onQuantityEnter={() => ingredientSearchRef.current?.focus()}
                      quantityRef={registerQuantity(key)}
                      cost={contribution !== null ? money(contribution) : DASH}
                      removeLabel={t('removeItem', { name: line.name })}
                      onRemove={() => {
                        setIngredientLines((prev) => prev.filter((_, i) => i !== index));
                        ingredientSearchRef.current?.focus();
                      }}
                    />
                  );
                })}
              </ul>
            )}
            <DishSearch
              ref={ingredientSearchRef}
              options={ingredientOptions.map((i) => ({
                id: i.id,
                name: i.name,
                hint: i.needsPricing ? t('needsPricing') : t(`ingredients.per.${i.dimension}`, { amount: money(i.priceCents) }),
              }))}
              usedIds={new Set(ingredientLines.map((l) => l.ingredientId))}
              placeholder={t('ingredients.search')}
              label={t('ingredients.searchLabel')}
              noMatches={(query) => t('noMatches', { query })}
              addedLabel={t('added')}
              onPick={pickIngredient}
            />
          </section>
        </CardContent>
      </Card>

      {/* ── Labour + extra costs ──────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-5 sm:p-7">
          <section aria-labelledby="dish-labour-heading" className="flex flex-col gap-3">
            <h2 id="dish-labour-heading" className="flex items-center gap-1.5 text-lg font-semibold text-foreground">
              {t('labour.title')}
              <InfoPopover label={t('infoLabel', { topic: t('labour.topic') })}>{t('labour.info')}</InfoPopover>
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field id="labour-hours" label={t('labour.hours')}>
                <Input
                  id="labour-hours"
                  ref={hoursRef}
                  inputMode="decimal"
                  value={hoursText}
                  placeholder="0"
                  aria-invalid={!labourBlank && !labourValid && hours === null}
                  onChange={(e) => setHoursText(e.target.value)}
                  className="h-12 text-right text-base tabular-nums"
                />
              </Field>
              <Field id="labour-rate" label={t('labour.rate')}>
                <MoneyInput
                  id="labour-rate"
                  value={rateText}
                  currency={currency}
                  invalid={!labourBlank && !labourValid && (rate === null || !Number.isFinite(rate))}
                  onChange={setRateText}
                />
              </Field>
              <div className="col-span-2 flex min-w-0 flex-col gap-1.5 sm:col-span-1">
                <span className="text-sm font-medium text-foreground">{t('labour.cost')}</span>
                <span
                  className={cn(
                    'flex h-12 items-center justify-end rounded-lg bg-surface-2 px-3 text-base font-semibold tabular-nums',
                    labourBlank ? 'text-muted-foreground' : 'text-foreground',
                  )}
                >
                  {labourBlank
                    ? t('labour.notEntered')
                    : cost.productionLabourCents !== null
                      ? money(cost.productionLabourCents)
                      : DASH}
                </span>
              </div>
            </div>
            {!labourBlank && !labourValid ? <p className="text-sm text-red-700 dark:text-red-300">{t('problems.labour')}</p> : null}
            {labourValid && extraHours > 0 && cost.workHours !== null ? (
              <p className="text-xs text-muted-foreground">
                {t('labour.extraWork', { hours: numberToField(extraHours), total: numberToField(cost.workHours) })}
              </p>
            ) : null}
          </section>

          <Accordion
            type="single"
            collapsible
            value={extrasOpen ? 'extras' : ''}
            onValueChange={(v) => setExtrasOpen(v === 'extras')}
            className="border-t border-border"
          >
            <AccordionItem value="extras" className="border-b-0">
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <AccordionTrigger className="items-center py-4 hover:no-underline">
                    <span className="flex w-full items-center justify-between gap-3 pr-1">
                      <span className="text-base font-semibold text-foreground">{t('extras.title')}</span>
                      <span className="text-sm tabular-nums text-muted-foreground">{extrasStatus}</span>
                    </span>
                  </AccordionTrigger>
                </div>
                <InfoPopover label={t('infoLabel', { topic: t('extras.topic') })}>{t('extras.info')}</InfoPopover>
              </div>
              <AccordionContent>
                <div className="flex flex-col gap-3">
                  {extras.length > 0 ? (
                    <ul className="flex flex-col gap-3">
                      {extras.map((extra, index) => {
                        const v = extraValues[index];
                        const amount = extraValid(index) && v ? money(v.kind === 'work' ? Math.round(v.hours * v.hourlyCents) : v.amountCents) : DASH;
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
                                className="h-11 text-base"
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
                                    className="h-11 text-right text-base tabular-nums"
                                  />
                                </Field>
                                <Field id={`extra-rate-${extra.key}`} label={t('extras.rate')} className="w-32">
                                  <MoneyInput
                                    id={`extra-rate-${extra.key}`}
                                    size="sm"
                                    value={extra.rate}
                                    currency={currency}
                                    onChange={(value) => patchExtra(extra.key, { rate: value })}
                                  />
                                </Field>
                              </>
                            ) : (
                              <Field id={`extra-amount-${extra.key}`} label={t('extras.amount')} className="w-32">
                                <MoneyInput
                                  id={`extra-amount-${extra.key}`}
                                  size="sm"
                                  value={extra.amount}
                                  currency={currency}
                                  onChange={(value) => patchExtra(extra.key, { amount: value })}
                                />
                              </Field>
                            )}
                            <span className="flex h-11 w-20 items-center justify-end text-sm font-semibold tabular-nums">{amount}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              aria-label={t('removeItem', { name: extra.description || (extra.kind === 'work' ? t('extras.workLabel') : t('extras.expenseLabel')) })}
                              onClick={() => setExtras((prev) => prev.filter((e) => e.key !== extra.key))}
                              className="size-10 p-0"
                            >
                              <X />
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => setExtras((prev) => [...prev, blankExtra('work')])} className="min-h-11">
                      <Plus />
                      {t('extras.addWork')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setExtras((prev) => [...prev, blankExtra('expense')])} className="min-h-11">
                      <Plus />
                      {t('extras.addExpense')}
                    </Button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>

      {/* ── Selling price, results, target ingredient margin ──────────────── */}
      <Card>
        <CardContent className="p-5 sm:p-7">
          <DishPricingPanel
            money={money}
            currency={currency}
            itemSingular={itemSingular}
            itemPlural={itemPlural}
            items={items}
            disabled={needsConversion}
            price={{
              exclText: priceText('excl'),
              inclText: priceText('incl'),
              exclInvalid: priceInvalid && priceDraft?.field === 'excl',
              inclInvalid: priceInvalid && priceDraft?.field === 'incl',
              onChange: onPriceChange,
              onBlur: () => {
                if (!priceInvalid) setPriceDraft(null);
              },
            }}
            vat={{
              text: vatText,
              invalid: !vatValid,
              placeholder: numberToField((defaultVatBps ?? 0) / 100),
              info:
                defaultVatBps !== null
                  ? t('price.vatInfo', { rate: `${numberToField(defaultVatBps / 100)}%` })
                  : t('price.vatInfoNone'),
              onChange: (text) => {
                setVatText(text);
                setPriceDraft(null);
              },
            }}
            cost={cost}
            results={results}
            missing={missing}
            target={{
              text: targetText,
              onChange: setTargetText,
              invalid: targetInvalid,
              targetBps,
              suggestedExcl,
              suggestedIncl,
              canUse: suggestedExcl !== null && !needsConversion && suggestedExcl !== priceExclCents,
              onUse: () => {
                if (suggestedExcl === null) return;
                setPriceExclCents(suggestedExcl);
                setPriceDraft(null);
              },
              coverNote,
            }}
          />
        </CardContent>
      </Card>

      {/* ── Notes (optional, quiet) ───────────────────────────────────────── */}
      <Card>
        <Accordion type="single" collapsible value={notesOpen ? 'notes' : ''} onValueChange={(v) => setNotesOpen(v === 'notes')}>
          <AccordionItem value="notes" className="border-b-0">
            <AccordionTrigger className="px-5 py-4 hover:no-underline sm:px-7">
              <span className="text-base font-semibold text-foreground">{t('fields.notesOptional')}</span>
            </AccordionTrigger>
            <AccordionContent className="px-5 sm:px-7">
              <Textarea
                id="dish-notes"
                aria-label={t('fields.notes')}
                value={notes}
                maxLength={1000}
                placeholder={t('fields.notesPlaceholder')}
                onChange={(e) => setNotes(e.target.value)}
              />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Card>

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
