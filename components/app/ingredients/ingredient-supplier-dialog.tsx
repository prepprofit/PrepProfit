'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IGNORE_PASSWORD_MANAGERS, Input } from '@/components/ui/input';
import { SupplierPicker } from '@/components/app/ingredients/supplier-picker';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useActionError } from '@/lib/i18n/use-action-error';
import { formatMoney } from '@/lib/format/money';
import { dimensionOf, formatInUnit, PRICED_UNIT_LABEL, unitLabel, type Dimension, type Unit } from '@/lib/units';
import {
  packCanonicalQuantity,
  resolveEnteredPrice,
  type EnteredPack,
  type PriceResolution,
} from '@/lib/calculations/ingredientPriceEntry';
import { CANONICAL_PER_PRICE_UNIT } from '@/lib/calculations/recipeCost';
import {
  parseMoneyText,
  parsePositiveDecimal,
  parseWholeCount,
  suggestPurchaseVat,
} from '@/lib/calculations/supplierPriceForm';
import type { UomAnchors } from '@/lib/calculations/uom';
import {
  applyVatRate,
  editPrice,
  EMPTY_PRICE_STATE,
  initPriceState,
  linkedPrices,
  setPriceBasis,
  type PriceEditState,
} from '@/lib/ingredients/price-editor';
import { PACK_UNITS } from '@/lib/validation/suppliers';
import { parseVatPercent } from '@/lib/validation/vat-rate';
import { InfoPopover } from '@/components/app/ingredients/info-popover';
import {
  acceptPendingCostAction,
  getSupplierEntryAction,
  updateIngredientEditorAction,
} from '@/app/(app)/ingredients/actions';
import type { DefaultSupplierSummary, IngredientEditorSupplierChange } from '@/lib/data/ingredient-suppliers';
import type { Ingredient } from '@/lib/db/schema';
import type { SupplierPricePrefs, VatCategoryOption } from '@/components/app/ingredients/ingredient-grid';

/**
 * The unified ingredient editor: name, supplier, the supplier's product name, ONE
 * connected pricing area, and collapsible product code + notes — one Save, one
 * Cancel. Opened from the row's pencil and from the supplier shortcut. Manager-only
 * (the server is the real gate).
 *
 * Pricing: pack size + pack price + price per kg / litre / piece are linked. Typing
 * either price calculates the other from the pack size; the last one typed is the
 * source. A price per kg needs no pack at all. One "Prices entered: excl./incl. VAT"
 * control applies to both prices; switching it converts the amounts (the net cost is
 * preserved), and VAT is removed exactly once, on the server, when saving. The maths
 * is `lib/calculations/ingredientPriceEntry` + `lib/ingredients/price-editor`, shared
 * with the server so what is previewed is what is stored.
 *
 * Save is atomic on the server: a price that cannot be worked out honestly (VAT rate
 * missing, pack missing, a pack unit that needs an equivalency) is refused with the
 * reason and every typed value stays in the form.
 */

const DEFAULT_PACK_UNIT: Record<Dimension, Unit> = { weight: 'kg', volume: 'l', count: 'count' };

type Touched = { pack: boolean; price: boolean; vat: boolean; basis: boolean; details: boolean; notes: boolean };
const UNTOUCHED: Touched = { pack: false, price: false, vat: false, basis: false, details: false, notes: false };

export type SupplierSavedNotice = { message: string };

/** Everything the grid needs to reconcile its local state after one atomic save. */
export type IngredientEditorSavedUpdate = {
  ingredient: Ingredient;
  supplierChange: IngredientEditorSupplierChange;
  prefs: SupplierPricePrefs | null;
  notice: SupplierSavedNotice | null;
};

type Seed = {
  units: string;
  size: string;
  packUnit: Unit;
  multipack: boolean;
  vatText: string;
  price: PriceEditState;
  productName: string;
  sku: string;
};

/** What the editor shows for one supplier entry (or a blank one), from stored data only. */
function buildSeed(input: {
  entry: DefaultSupplierSummary | null;
  dimension: Dimension;
  currentPriceCents: number | null;
  prefs: SupplierPricePrefs | undefined;
  anchors: UomAnchors | null;
  vatSources: { ingredientBps: number | null; bandBps: number | null; businessBps: number | null; mostCommonBps: number | null };
}): Seed {
  const { entry, dimension } = input;
  const suggestion = suggestPurchaseVat({ entryBps: entry?.vatRateBps ?? null, ...input.vatSources });
  const rate = suggestion?.bps ?? null;
  const units = entry?.unitsPerPack ?? 1;
  const size = entry?.packSize ?? null;
  const packUnit = (entry?.packUnit as Unit | null) ?? DEFAULT_PACK_UNIT[dimension];
  // A known entry keeps the basis it was quoted in (only while a rate exists to show
  // it); a new entry always starts excluding VAT.
  const includesVat = entry !== null && (input.prefs?.includesVat ?? false) && rate !== null;
  const pack: EnteredPack | null =
    size !== null && entry?.packUnit ? { unitsPerPack: units, packSize: size, packUnit } : null;
  const quantity = packCanonicalQuantity(pack, dimension, input.anchors);

  let price: PriceEditState;
  if (entry?.packPriceCents != null && quantity.ok) {
    price =
      input.prefs?.basis === 'priced'
        ? initPriceState({
            source: 'unit',
            netCents: (entry.packPriceCents * CANONICAL_PER_PRICE_UNIT[dimension]) / quantity.canonical,
            includesVat,
            vatBps: rate,
          })
        : initPriceState({ source: 'pack', netCents: entry.packPriceCents, includesVat, vatBps: rate });
  } else if (input.currentPriceCents != null && input.currentPriceCents > 0) {
    // No supplier-specific price yet: the ingredient's own cost initialises the calculator.
    price = initPriceState({ source: 'unit', netCents: input.currentPriceCents, includesVat, vatBps: rate });
  } else {
    price = { ...EMPTY_PRICE_STATE, includesVat };
  }

  return {
    units: String(units),
    size: size !== null ? String(size) : '',
    packUnit,
    multipack: units > 1,
    vatText: rate !== null ? String(rate / 100) : '',
    price,
    productName: entry?.supplierProductName ?? '',
    sku: entry?.supplierSku ?? '',
  };
}

export function IngredientSupplierDialog({
  open,
  ingredientId,
  ingredientName,
  dimension,
  currency,
  vatCategories,
  vatCategoryId: ingredientBandId,
  vatRateBps: ingredientVatBps,
  businessPurchaseVatBps,
  mostCommonPurchaseVatBps,
  supplierNames,
  pricePrefs,
  initialLink,
  currentPriceCents,
  pendingPriceCents,
  notes,
  anchors,
  focusSection = 'name',
  onClose,
  onSaved,
  onAccepted,
}: {
  open: boolean;
  ingredientId: string;
  ingredientName: string;
  dimension: Dimension;
  currency: string;
  /** VAT bands — only used to suggest a rate. */
  vatCategories: VatCategoryOption[];
  /** The ingredient's explicitly chosen VAT band (legacy); null = none. */
  vatCategoryId: string | null;
  /** The ingredient's own purchase VAT (bps); null = not set. */
  vatRateBps: number | null;
  /** The business's configured default purchase VAT (bps); null = none. */
  businessPurchaseVatBps: number | null;
  /** Last-resort prefill: the business's most common CONFIRMED purchase VAT rate. */
  mostCommonPurchaseVatBps: number | null;
  supplierNames: string[];
  pricePrefs: Record<string, SupplierPricePrefs>;
  initialLink: DefaultSupplierSummary | null;
  /** The ingredient's active cost per priced unit (excl. VAT); null = not priced. */
  currentPriceCents: number | null;
  pendingPriceCents: number | null;
  /** Free-text notes stored on the ingredient; null/empty = none yet. */
  notes: string | null;
  /** The ingredient's own unit equivalency, when it has one. */
  anchors: UomAnchors | null;
  /** Which entry point opened the dialog — steers initial focus/scroll only. */
  focusSection?: 'name' | 'supplier';
  onClose: () => void;
  onSaved: (update: IngredientEditorSavedUpdate) => void;
  onAccepted: (priceCents: number) => void;
}) {
  const t = useTranslations('suppliers.ingredientEditor');
  const tIngredients = useTranslations('ingredients');
  const actionError = useActionError();
  const ref = React.useRef<HTMLDialogElement>(null);
  const nameInputRef = React.useRef<HTMLInputElement>(null);
  const supplierFieldRef = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const pricedUnit = PRICED_UNIT_LABEL[dimension];

  const bandBps = vatCategories.find((c) => c.id === ingredientBandId)?.rateBps ?? null;
  const vatSources = {
    ingredientBps: ingredientVatBps,
    bandBps,
    businessBps: businessPurchaseVatBps,
    mostCommonBps: mostCommonPurchaseVatBps,
  };

  const suggestion = suggestPurchaseVat({ entryBps: initialLink?.vatRateBps ?? null, ...vatSources });

  // ── Form state ────────────────────────────────────────────────────────────
  const [name, setName] = React.useState(ingredientName);
  const [supplierName, setSupplierName] = React.useState('');
  const [productName, setProductName] = React.useState('');
  const [sku, setSku] = React.useState('');
  const [multipack, setMultipack] = React.useState(false);
  const [unitsText, setUnitsText] = React.useState('1');
  const [sizeText, setSizeText] = React.useState('');
  const [packUnit, setPackUnit] = React.useState<Unit>(DEFAULT_PACK_UNIT[dimension]);
  const [vatText, setVatText] = React.useState('');
  const [price, setPrice] = React.useState<PriceEditState>(EMPTY_PRICE_STATE);
  const [notesText, setNotesText] = React.useState('');
  /** Which parts the manager changed — untouched parts are not sent, so the server keeps them. */
  const [touched, setTouched] = React.useState<Touched>(UNTOUCHED);
  const [showCode, setShowCode] = React.useState(false);
  const [showNotes, setShowNotes] = React.useState(false);
  const [basisBlocked, setBasisBlocked] = React.useState(false);
  const [bannerError, setBannerError] = React.useState<string | null>(null);
  const [nameAttempted, setNameAttempted] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  /** Supplier the fields currently describe (guards stale lookups when switching quickly). */
  const shownFor = React.useRef('');

  const touch = (part: keyof Touched) => setTouched((prev) => (prev[part] ? prev : { ...prev, [part]: true }));

  function applySeed(seed: Seed, parts: { identity: boolean; pricing: boolean }) {
    if (parts.identity) {
      setProductName(seed.productName);
      setSku(seed.sku);
    }
    if (parts.pricing) {
      setUnitsText(seed.units);
      setSizeText(seed.size);
      setPackUnit(seed.packUnit);
      setMultipack(seed.multipack);
      setVatText(seed.vatText);
      setPrice(seed.price);
      setBasisBlocked(false);
    }
  }

  function seedFor(entry: DefaultSupplierSummary | null, supplier: string): Seed {
    return buildSeed({ entry, dimension, currentPriceCents, prefs: pricePrefs[supplier], anchors, vatSources });
  }

  // Re-seed from what is stored whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const supplier = initialLink?.supplierName ?? '';
    setName(ingredientName);
    setSupplierName(supplier);
    setNotesText(notes ?? '');
    applySeed(seedFor(initialLink, supplier), { identity: true, pricing: true });
    shownFor.current = supplier.trim().toLowerCase();
    setTouched(UNTOUCHED);
    setBannerError(null);
    setNameAttempted(false);
    setShowCode(false);
    setShowNotes(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per open / stored entry
  }, [open, initialLink, dimension, ingredientName, currentPriceCents, notes]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // Focus (and for the supplier entry point, scroll) to the field this dialog was
  // opened for, once the native <dialog> has actually opened.
  React.useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      if (focusSection === 'supplier') {
        supplierFieldRef.current?.scrollIntoView({ block: 'nearest' });
        supplierFieldRef.current?.querySelector('input')?.focus();
      } else {
        nameInputRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, focusSection]);

  // Each supplier has its own product name, code, pack, price and VAT for this
  // ingredient. Switching supplier shows THAT supplier's stored entry (blank when not
  // linked yet) instead of leaving the previous supplier's numbers on screen. Anything
  // the manager already typed is kept and saved against the newly picked supplier.
  function onSupplierChange(value: string) {
    setSupplierName(value);
    const key = value.trim().toLowerCase();
    if (key === shownFor.current) return;
    shownFor.current = key;
    const parts = {
      identity: !touched.details,
      pricing: !(touched.pack || touched.price || touched.vat || touched.basis),
    };
    if (!parts.identity && !parts.pricing) return;

    if (key === '') {
      applySeed(seedFor(null, ''), parts);
      return;
    }
    if (initialLink && initialLink.supplierName.trim().toLowerCase() === key) {
      applySeed(seedFor(initialLink, initialLink.supplierName), parts);
      return;
    }
    void getSupplierEntryAction(ingredientId, value.trim()).then((result) => {
      if (shownFor.current !== key) return;
      if (!result.ok) {
        setBannerError(actionError(result.code));
        return;
      }
      applySeed(seedFor(result.data, result.data?.supplierName ?? value.trim()), parts);
    });
  }

  // ── Parsed values ─────────────────────────────────────────────────────────
  const ingredientNameMissing = name.trim() === '';
  const hasSupplier = supplierName.trim() !== '';
  const units = multipack ? parseWholeCount(unitsText) : 1;
  const unitsInvalid = multipack && units === null;
  const size = sizeText.trim() === '' ? null : parsePositiveDecimal(sizeText);
  const sizeInvalid = sizeText.trim() !== '' && size === null;
  const pack: EnteredPack | null = units !== null && size !== null ? { unitsPerPack: units, packSize: size, packUnit } : null;
  const vatParsed = parseVatPercent(vatText);
  const vatInvalid = vatParsed === 'invalid';
  const vatBps = vatParsed === 'invalid' ? null : vatParsed;

  const linked = linkedPrices(price, pack, dimension, anchors);
  const sourceCents = parseMoneyText(price.text);
  const priceInvalid = price.text.trim() !== '' && sourceCents === null;
  const hasPrice = sourceCents !== null && !price.textStale;
  const pricingChanged = touched.price || touched.pack || (touched.vat && price.includesVat);
  const willSendPrice = pricingChanged && hasPrice;

  const resolution: PriceResolution | null =
    hasPrice && sourceCents !== null
      ? resolveEnteredPrice({
          source: price.source,
          amountCents: sourceCents,
          includesVat: price.includesVat,
          vatRateBps: vatBps,
          pack,
          dimension,
          anchors,
        })
      : null;
  const failure = willSendPrice && resolution && !resolution.ok ? resolution.reason : null;
  const netUnitCents = resolution?.ok ? resolution.value.netUnitCents : null;

  const vatHint = touched.vat
    ? vatParsed === 0
      ? t('vatRateZero')
      : vatBps === null
        ? t('vatHint.cleared')
        : null
    : suggestion
      ? t(`vatHint.${suggestion.source}`)
      : t('vatHint.none');

  const totalLabel = pack ? formatInUnit(pack.unitsPerPack * pack.packSize, packUnit) : null;
  const packIssueText =
    failure === 'pack_required'
      ? t('issues.packRequired', { unit: pricedUnit })
      : failure === 'needs_equivalency' || (linked.packIssue === 'needs_equivalency' && pack)
        ? t('issues.needsEquivalency', { pack: totalLabel ?? '', unit: pricedUnit })
        : null;
  const vatNeeded = price.includesVat && vatBps === null && !vatInvalid && (price.textStale || sourceCents !== null || basisBlocked);
  const fieldBlocked =
    sizeInvalid ||
    unitsInvalid ||
    vatInvalid ||
    (touched.price && priceInvalid) ||
    failure === 'pack_required' ||
    failure === 'needs_equivalency' ||
    failure === 'vat_rate_required';

  const unitOptions = React.useMemo(() => {
    const compatible: Unit[] = PACK_UNITS.filter((u) => dimensionOf(u) === dimension);
    return compatible.includes(packUnit) ? compatible : [...compatible, packUnit];
  }, [dimension, packUnit]);

  // ── Price edits ───────────────────────────────────────────────────────────
  function onPriceEdit(source: 'pack' | 'unit', text: string) {
    setPrice((prev) => editPrice(prev, source, text, vatBps));
    setBasisBlocked(false);
    touch('price');
  }
  function onBasisChange(includesVat: boolean) {
    const result = setPriceBasis(price, includesVat, vatBps);
    if (!result.ok) {
      setBasisBlocked(true);
      return;
    }
    setBasisBlocked(false);
    setPrice(result.state);
    touch('basis');
  }
  function onVatChange(text: string) {
    setVatText(text);
    const parsed = parseVatPercent(text);
    setPrice((prev) => applyVatRate(prev, parsed === 'invalid' ? null : parsed));
    setBasisBlocked(false);
    touch('vat');
  }
  function onSizeChange(text: string) {
    setSizeText(text);
    touch('pack');
  }
  function toggleMultipack() {
    if (!multipack) {
      setMultipack(true);
    } else {
      // Back to one total: keep the total quantity the units × size stood for.
      if (units !== null && units > 1 && size !== null) setSizeText(String(Number((units * size).toPrecision(12))));
      setUnitsText('1');
      setMultipack(false);
    }
    touch('pack');
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  function directUnitCents(): number | null {
    if (!willSendPrice) return null;
    return price.source === 'unit' ? sourceCents : parseMoneyText(linked.unitText);
  }

  function buildSupplierPayload(): Record<string, unknown> {
    const supplier: Record<string, unknown> = { supplierName: supplierName.trim() };
    if (touched.details) {
      supplier.supplierProductName = productName.trim();
      supplier.supplierSku = sku.trim();
    }
    if (touched.pack) {
      supplier.unitsPerPack = units ?? 1;
      supplier.packSize = size;
      supplier.packUnit = packUnit;
    }
    // Only a deliberate VAT edit is remembered; a suggested default is not stored.
    if (touched.vat) supplier.vatRateBps = vatBps;
    if (willSendPrice) {
      supplier.packPriceCents = sourceCents;
      supplier.priceBasis = price.source === 'pack' ? 'pack' : 'priced';
      supplier.priceIncludesVat = price.includesVat;
    } else if (touched.basis || touched.vat) {
      supplier.priceIncludesVat = price.includesVat;
    }
    return supplier;
  }

  function save(options?: { clearSupplier?: boolean }) {
    const wantsClear = options?.clearSupplier === true;
    setNameAttempted(true);
    if (ingredientNameMissing || fieldBlocked) return;
    setBannerError(null);
    startTransition(async () => {
      const payload: Record<string, unknown> = { name: name.trim(), dimension };
      if (touched.notes) payload.notes = notesText.trim();
      if (wantsClear || !hasSupplier) {
        if (wantsClear) payload.clearSupplier = true;
        const direct = directUnitCents();
        if (direct !== null) {
          payload.priceCents = direct;
          payload.priceIncludesVat = price.includesVat;
          payload.priceVatRateBps = price.includesVat ? vatBps : null;
        }
      } else {
        payload.supplier = buildSupplierPayload();
      }

      const result = await updateIngredientEditorAction(ingredientId, payload);
      if (!result.ok) {
        // Everything typed stays in the form so it can be corrected and saved again.
        setBannerError(actionError(result.code));
        return;
      }

      const { ingredient, supplierChange } = result.data;
      let prefs: SupplierPricePrefs | null = null;
      if (supplierChange.type === 'set' && (willSendPrice || touched.basis || touched.vat)) {
        prefs = {
          basis: willSendPrice ? (price.source === 'pack' ? 'pack' : 'priced') : (pricePrefs[supplierChange.link.supplierName]?.basis ?? null),
          includesVat: price.includesVat,
        };
      }
      const costUpdated = ingredient.priceCents !== (currentPriceCents ?? null) && willSendPrice;
      const notice: SupplierSavedNotice = {
        message: costUpdated
          ? t('saved.priceApplied', { amount: formatMoney(ingredient.priceCents, currency), unit: pricedUnit })
          : t('saved.ok'),
      };

      onSaved({ ingredient, supplierChange, prefs, notice });
      onClose();
    });
  }

  function acceptPending() {
    setBannerError(null);
    startTransition(async () => {
      const result = await acceptPendingCostAction(ingredientId);
      if (result.ok) {
        onAccepted(result.data.priceCents);
        onClose();
      } else {
        setBannerError(actionError(result.code));
      }
    });
  }

  const basisLabel = price.includesVat ? t('vat.incl') : t('vat.excl');
  const packDerived = linked.source !== 'pack' && linked.packText !== '';
  const unitDerived = linked.source !== 'unit' && linked.unitText !== '';
  const noteHasText = notesText.trim() !== '';
  const codeHasText = sku.trim() !== '';

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !pending) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-surface p-0 text-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <form
        className="flex max-h-[88vh] flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex flex-col gap-3.5 overflow-y-auto p-5">
          <div className="flex flex-col gap-1">
            <Label id={`${id}-title`} htmlFor={`${id}-ingredient-name`} className="text-xs text-muted-foreground">
              {t('ingredientNameLabel')}
            </Label>
            <Input
              {...IGNORE_PASSWORD_MANAGERS}
              ref={nameInputRef}
              id={`${id}-ingredient-name`}
              value={name}
              disabled={pending}
              aria-invalid={nameAttempted && ingredientNameMissing}
              aria-describedby={nameAttempted && ingredientNameMissing ? `${id}-ingredient-name-error` : undefined}
              className="font-display text-lg font-semibold"
              onChange={(e) => {
                setName(e.target.value);
                setNameAttempted(false);
              }}
            />
            {nameAttempted && ingredientNameMissing && (
              <p id={`${id}-ingredient-name-error`} className="text-xs text-red-700 dark:text-red-300">
                {tIngredients('errors.nameRequired')}
              </p>
            )}
          </div>

          {pendingPriceCents != null && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs dark:border-amber-500/30 dark:bg-amber-500/10">
              <p className="text-amber-800 dark:text-amber-200">
                {t('pendingHint', { amount: formatMoney(pendingPriceCents, currency) })}
              </p>
              <Button type="button" size="sm" variant="outline" onClick={acceptPending} disabled={pending}>
                {t('accept')}
              </Button>
            </div>
          )}

          <div ref={supplierFieldRef} className="flex flex-col gap-1">
            <Label htmlFor={`${id}-name`} className="text-xs text-muted-foreground">
              {t('supplierName')}
            </Label>
            <SupplierPicker
              id={`${id}-name`}
              value={supplierName}
              options={supplierNames}
              disabled={pending}
              invalid={false}
              onChange={onSupplierChange}
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`${id}-product`} className="text-xs text-muted-foreground">
                {t('productName')}
              </Label>
              <InfoPopover label={t('infoLabel')}>{t('productNameHint')}</InfoPopover>
            </div>
            <Input
              {...IGNORE_PASSWORD_MANAGERS}
              id={`${id}-product`}
              placeholder={t('productNamePlaceholder')}
              value={productName}
              disabled={pending || !hasSupplier}
              onChange={(e) => {
                setProductName(e.target.value);
                touch('details');
              }}
            />
          </div>

          {/* One connected pricing area: VAT basis, pack, pack price, price per unit. */}
          <section aria-label={t('pricesEntered')} className="flex flex-col gap-2.5 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-basis`} className="text-xs text-muted-foreground">
                  {t('pricesEntered')}
                </Label>
                <div className="w-36">
                  <Select
                    id={`${id}-basis`}
                    value={price.includesVat ? 'incl' : 'excl'}
                    disabled={pending}
                    onChange={(e) => onBasisChange(e.target.value === 'incl')}
                  >
                    <option value="excl">{t('vatBasis.excl')}</option>
                    <option value="incl">{t('vatBasis.incl')}</option>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-vat`} className="text-xs text-muted-foreground">
                  {t('vatRate')}
                </Label>
                <div className="relative w-24">
                  <Input
                    {...IGNORE_PASSWORD_MANAGERS}
                    id={`${id}-vat`}
                    inputMode="decimal"
                    placeholder={t('vatRateUnset')}
                    value={vatText}
                    disabled={pending}
                    aria-invalid={vatInvalid}
                    aria-describedby={vatInvalid || vatNeeded || basisBlocked ? `${id}-vat-note` : undefined}
                    className="pr-7 text-right tabular-nums"
                    onChange={(e) => onVatChange(e.target.value)}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    %
                  </span>
                </div>
              </div>
              <InfoPopover label={t('infoLabel')} className="mb-3">
                <span className="font-medium text-foreground">{t('pricingInfoTitle')}</span>
                <br />
                {t('pricingInfo')}
                <br />
                <span className="mt-1 inline-block">{vatHint}</span>
              </InfoPopover>
            </div>
            {vatInvalid && (
              <p id={`${id}-vat-note`} className="-mt-1 text-xs text-red-700 dark:text-red-300">
                {t('vatRateInvalid')}
              </p>
            )}
            {!vatInvalid && basisBlocked && (
              <p id={`${id}-vat-note`} role="status" className="-mt-1 text-xs text-amber-700 dark:text-amber-300">
                {t('vatSwitchNeedsRate')}
              </p>
            )}
            {!vatInvalid && !basisBlocked && vatNeeded && (
              <p id={`${id}-vat-note`} role="status" className="-mt-1 text-xs text-amber-700 dark:text-amber-300">
                {t('vatRateNeeded')}
              </p>
            )}

            <div className={cn('grid gap-2', multipack ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3')}>
              <div className={cn('flex flex-col gap-1', multipack ? 'col-span-2' : 'col-span-2 sm:col-span-1')}>
                <Label htmlFor={`${id}-size`} className="text-xs text-muted-foreground">
                  {multipack ? `${t('multipack.units')} × ${t('multipack.each')}` : t('packSize')}
                </Label>
                <div className="flex items-center gap-1.5">
                  {multipack && (
                    <>
                      <Input
                        {...IGNORE_PASSWORD_MANAGERS}
                        id={`${id}-units`}
                        aria-label={t('multipack.units')}
                        inputMode="numeric"
                        value={unitsText}
                        disabled={pending}
                        aria-invalid={unitsInvalid}
                        className="w-16 shrink-0 text-right tabular-nums"
                        onChange={(e) => {
                          setUnitsText(e.target.value);
                          touch('pack');
                        }}
                      />
                      <span aria-hidden className="text-sm text-muted-foreground">
                        ×
                      </span>
                    </>
                  )}
                  <Input
                    {...IGNORE_PASSWORD_MANAGERS}
                    id={`${id}-size`}
                    inputMode="decimal"
                    value={sizeText}
                    disabled={pending}
                    aria-invalid={sizeInvalid}
                    className="min-w-0 flex-1 text-right tabular-nums"
                    onChange={(e) => onSizeChange(e.target.value)}
                  />
                  <div className="w-[4.75rem] shrink-0">
                    <Select
                      aria-label={t('packUnit')}
                      value={packUnit}
                      disabled={pending}
                      onChange={(e) => {
                        setPackUnit(e.target.value as Unit);
                        touch('pack');
                      }}
                    >
                      {unitOptions.map((u) => (
                        <option key={u} value={u}>
                          {unitLabel(u) || u}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                {multipack && totalLabel && (
                  <p className="text-xs text-muted-foreground">{t('multipack.total', { total: totalLabel })}</p>
                )}
              </div>

              <PriceField
                id={`${id}-pack-price`}
                label={t('packPriceLabel', { basis: basisLabel })}
                currency={currency}
                value={linked.packText}
                calculated={packDerived}
                calculatedLabel={t('calculated')}
                invalid={price.source === 'pack' && priceInvalid}
                disabled={pending}
                onChange={(text) => onPriceEdit('pack', text)}
              />
              <PriceField
                id={`${id}-unit-price`}
                label={t('unitPriceLabel', { unit: pricedUnit, basis: basisLabel })}
                currency={currency}
                value={linked.unitText}
                calculated={unitDerived}
                calculatedLabel={t('calculated')}
                invalid={price.source === 'unit' && priceInvalid}
                disabled={pending}
                emphasis
                onChange={(text) => onPriceEdit('unit', text)}
              />
            </div>

            {sizeInvalid && <p className="text-xs text-red-700 dark:text-red-300">{t('fieldErrors.packSizeInvalid')}</p>}
            {unitsInvalid && <p className="text-xs text-red-700 dark:text-red-300">{t('fieldErrors.unitsInvalid')}</p>}
            {touched.price && priceInvalid && (
              <p className="text-xs text-red-700 dark:text-red-300">{t('fieldErrors.priceInvalid')}</p>
            )}
            {packIssueText && (
              <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
                {packIssueText}
              </p>
            )}
            {price.includesVat && netUnitCents !== null && (
              <p className="text-xs text-muted-foreground">
                {t('netUnitCost', { amount: formatMoney(netUnitCents, currency), unit: pricedUnit })}
              </p>
            )}

            <button
              type="button"
              onClick={toggleMultipack}
              disabled={pending}
              className="-ml-1 flex min-h-9 w-fit cursor-pointer items-center px-1 text-xs font-medium text-accent-700 hover:underline disabled:opacity-50 dark:text-accent-300"
            >
              {multipack ? t('multipack.single') : t('multipack.toggle')}
            </button>
          </section>

          <div className="flex flex-wrap gap-2">
            {hasSupplier && (
              <Disclosure
                label={t('sku')}
                expanded={showCode}
                indicator={codeHasText ? t('notes.added') : null}
                controls={`${id}-code`}
                onToggle={() => setShowCode((v) => !v)}
              />
            )}
            <Disclosure
              label={t('notes.title')}
              expanded={showNotes}
              indicator={noteHasText ? t('notes.added') : null}
              controls={`${id}-notes`}
              onToggle={() => setShowNotes((v) => !v)}
            />
          </div>
          {/* Hidden, never unmounted or reset, so collapsing keeps any unsaved edit. */}
          <div id={`${id}-code`} hidden={!showCode || !hasSupplier}>
            <Label htmlFor={`${id}-sku`} className="sr-only">
              {t('sku')}
            </Label>
            {/* Plain text on purpose: codes keep letters, leading zeros and punctuation. */}
            <Input
              {...IGNORE_PASSWORD_MANAGERS}
              id={`${id}-sku`}
              type="text"
              inputMode="text"
              spellCheck={false}
              autoCapitalize="off"
              placeholder={t('skuPlaceholder')}
              value={sku}
              disabled={pending || !hasSupplier}
              onChange={(e) => {
                setSku(e.target.value);
                touch('details');
              }}
            />
          </div>
          <div id={`${id}-notes`} hidden={!showNotes}>
            <Label htmlFor={`${id}-notes-field`} className="sr-only">
              {t('notes.title')}
            </Label>
            <Textarea
              id={`${id}-notes-field`}
              placeholder={t('notes.placeholder')}
              value={notesText}
              disabled={pending}
              rows={3}
              onChange={(e) => {
                setNotesText(e.target.value);
                touch('notes');
              }}
            />
          </div>
        </div>

        {/* Save stays in reach at the bottom of the dialog, with any real problem beside it. */}
        <div className="flex flex-col gap-2 border-t border-border px-5 py-3">
          {bannerError && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
            >
              {bannerError}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            {initialLink ? (
              <Button type="button" variant="ghost" onClick={() => save({ clearSupplier: true })} disabled={pending}>
                {t('clear')}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? t('saving') : t('save')}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </dialog>
  );
}

function Disclosure({
  label,
  expanded,
  indicator,
  controls,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  /** Accessible/hover text for the small dot shown when the section holds something. */
  indicator: string | null;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-surface-2"
    >
      <ChevronDown
        className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !expanded && '-rotate-90')}
        aria-hidden
      />
      <span>{label}</span>
      {indicator && (
        <span title={indicator} className="size-1.5 rounded-full bg-accent-500">
          <span className="sr-only">{indicator}</span>
        </span>
      )}
    </button>
  );
}

function PriceField({
  id,
  label,
  currency,
  value,
  calculated,
  calculatedLabel,
  invalid,
  disabled,
  emphasis = false,
  onChange,
}: {
  id: string;
  label: string;
  currency: string;
  value: string;
  calculated: boolean;
  calculatedLabel: string;
  invalid: boolean;
  disabled: boolean;
  emphasis?: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="truncate text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="relative">
        <Input
          {...IGNORE_PASSWORD_MANAGERS}
          id={id}
          inputMode="decimal"
          placeholder="—"
          value={value}
          disabled={disabled}
          aria-invalid={invalid}
          className={cn(
            'pr-11 text-right tabular-nums',
            emphasis && 'font-semibold',
            calculated && 'bg-accent-50/50 dark:bg-accent-500/10',
          )}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
          {currency}
        </span>
        {calculated && (
          <span className="pointer-events-none absolute -top-2 left-2.5 rounded-full bg-surface px-1.5 text-[10px] font-medium leading-4 text-accent-700 dark:text-accent-300">
            {calculatedLabel}
          </span>
        )}
      </div>
    </div>
  );
}
