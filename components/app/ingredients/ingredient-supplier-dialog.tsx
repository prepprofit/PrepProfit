'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IGNORE_PASSWORD_MANAGERS, Input } from '@/components/ui/input';
import { SupplierPicker } from '@/components/app/ingredients/supplier-picker';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useActionError } from '@/lib/i18n/use-action-error';
import { centsToAmountInput, formatMoney, parseMoneyToCents } from '@/lib/format/money';
import { Textarea } from '@/components/ui/textarea';
import { dimensionOf, formatInUnit, PRICED_UNIT_LABEL, unitLabel, type Dimension, type Unit } from '@/lib/units';
import { quotedPriceCents, supplierUnitCost } from '@/lib/calculations/purchasePrice';
import {
  derivePriceCents,
  parseMoneyText,
  parsePositiveDecimal,
  parseWholeCount,
  suggestPurchaseVat,
  type PriceSource,
} from '@/lib/calculations/supplierPriceForm';
import { PACK_UNITS } from '@/lib/validation/suppliers';
import { parseVatPercent } from '@/lib/validation/vat-rate';
import { InfoPopover } from '@/components/app/ingredients/info-popover';
import {
  acceptPendingCostAction,
  getSupplierProductIdentityAction,
  updateIngredientEditorAction,
} from '@/app/(app)/ingredients/actions';
import type { DefaultSupplierSummary, IngredientEditorSupplierChange } from '@/lib/data/ingredient-suppliers';
import type { Ingredient } from '@/lib/db/schema';
import type { SupplierPricePrefs, VatCategoryOption } from '@/components/app/ingredients/ingredient-grid';

/**
 * The UNIFIED ingredient editor (name, supplier, product identity, price, pack &
 * VAT, and the measurement type) — one dialog, one Save, one Cancel. Opened by
 * BOTH the row's pencil (`focusSection: 'name'`) and the supplier shortcut beneath
 * the ingredient name (`focusSection: 'supplier'`); the underlying fields and
 * saving behaviour are identical either way. Manager-only (the server is the real
 * gate).
 *
 * Supplier first, pricing optional: pick a supplier and Save — nothing else is
 * required. Pack, price and VAT can be completed later, one at a time; a part left
 * as it was keeps its stored value, a cleared field is stored as unknown (never 0),
 * and a typo is marked beside its field without blocking the rest.
 *
 * The visible "Price per kg / litre / piece" field means different things
 * depending on whether a supplier is attached to this save: with NO supplier it is
 * a direct, immediate edit of the ingredient's approved cost (exactly like the old
 * standalone editor); with a supplier it is that supplier's QUOTED unit price,
 * calculated bidirectionally against the pack price in "Pack & VAT details" and
 * saved through the existing pending/accept safeguard (a new quote never overwrites
 * the approved cost silently — Sprint 7 / §12.6). VAT is suggested from what the
 * system already knows and applied once, on the server, when an incl.-VAT price is
 * stored as the net pack price.
 *
 * Everything here is ONE atomic save (`updateIngredientEditorAction`): the name,
 * the measurement type, and the supplier link commit together or not at all.
 */

const DEFAULT_PACK_UNIT: Record<Dimension, Unit> = { weight: 'kg', volume: 'l', count: 'count' };

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-red-700 dark:text-red-300">
      {message}
    </p>
  );
}

export type SupplierSavedNotice = { message: string; incomplete: boolean };

/** Everything the grid needs to reconcile its local state after one atomic save. */
export type IngredientEditorSavedUpdate = {
  ingredient: Ingredient;
  supplierChange: IngredientEditorSupplierChange;
  prefs: SupplierPricePrefs | null;
  notice: SupplierSavedNotice | null;
};

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
  /** VAT bands — offered as one-click shortcuts only. */
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
  /** The ingredient's approved cost per priced unit (excl. VAT); null = not priced. */
  currentPriceCents: number | null;
  pendingPriceCents: number | null;
  /** Free-text notes stored on the ingredient; null/empty = none yet. */
  notes: string | null;
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
  const unitOptions = React.useMemo(() => PACK_UNITS.filter((u) => dimensionOf(u) === dimension), [dimension]);

  // ── Form state ────────────────────────────────────────────────────────────
  const [name, setName] = React.useState(ingredientName);
  const [directPriceText, setDirectPriceText] = React.useState('');
  const [directPriceTouched, setDirectPriceTouched] = React.useState(false);
  const [supplierName, setSupplierName] = React.useState('');
  const [productName, setProductName] = React.useState('');
  const [sku, setSku] = React.useState('');
  const [unitsText, setUnitsText] = React.useState('1');
  const [sizeText, setSizeText] = React.useState('');
  const [packUnit, setPackUnit] = React.useState<Unit>(DEFAULT_PACK_UNIT[dimension]);
  const [includesVat, setIncludesVat] = React.useState(false);
  const [vatText, setVatText] = React.useState('');
  const [vatTouched, setVatTouched] = React.useState(false);
  const [priceSource, setPriceSource] = React.useState<PriceSource>('pack');
  const [sourceText, setSourceText] = React.useState('');
  /**
   * True while the price shown is a FALLBACK seeded from the ingredient's current
   * cost (no supplier-specific price exists yet) — never a confirmed supplier quote.
   * Cleared the moment a price is deliberately typed. Opening the editor or expanding
   * Pack & price never writes anything; this only affects what's shown.
   */
  const [priceIsFallback, setPriceIsFallback] = React.useState(false);
  const [notesText, setNotesText] = React.useState('');
  const [notesTouched, setNotesTouched] = React.useState(false);
  /** Which parts were changed — untouched parts aren't sent, so the server keeps them. */
  const [touched, setTouched] = React.useState({ pack: false, price: false, details: false });
  /** Pack & VAT starts collapsed (expanded when opened from the supplier shortcut). */
  const [showPricing, setShowPricing] = React.useState(false);
  /** Notes start collapsed; expanded automatically when one is already saved. */
  const [showNotes, setShowNotes] = React.useState(false);
  /** Supplier whose product name/code the fields currently show (guards stale lookups). */
  const identityFor = React.useRef<string | null>(null);
  const [bannerError, setBannerError] = React.useState<string | null>(null);
  const [priceNotice, setPriceNotice] = React.useState<string | null>(null);
  const [nameAttempted, setNameAttempted] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const seededFor = React.useRef<string | null>(null);

  const suggestion = suggestPurchaseVat({
    entryBps: initialLink?.vatRateBps ?? null,
    ingredientBps: ingredientVatBps,
    bandBps,
    businessBps: businessPurchaseVatBps,
    mostCommonBps: mostCommonPurchaseVatBps,
  });

  // Re-seed from what is stored whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    setName(ingredientName);
    setDirectPriceText(currentPriceCents != null ? centsToAmountInput(currentPriceCents) : '');
    setDirectPriceTouched(false);
    setNotesText(notes ?? '');
    setNotesTouched(false);

    const supplier = initialLink?.supplierName ?? '';
    const units = initialLink?.unitsPerPack ?? 1;
    const size = initialLink?.packSize ?? null;
    const unit = (initialLink?.packUnit as Unit | null) ?? DEFAULT_PACK_UNIT[dimension];
    const rate = suggestion?.bps ?? null;
    const prefs = pricePrefs[supplier];
    // A supplier who quotes incl. VAT is shown that way only while a rate is known.
    const inclVat = (prefs?.includesVat ?? false) && rate != null;
    const showUnitPrice = prefs?.basis === 'priced';

    setSupplierName(supplier);
    setProductName(initialLink?.supplierProductName ?? '');
    setSku(initialLink?.supplierSku ?? '');
    identityFor.current = supplier;
    setUnitsText(String(units));
    setSizeText(size != null ? String(size) : '');
    setPackUnit(unit);
    setIncludesVat(inclVat);
    setVatText(rate != null ? String(rate / 100) : '');
    setVatTouched(false);
    setTouched({ pack: false, price: false, details: false });

    // The stored net pack price shown back on the chosen basis (display only).
    const stored = initialLink?.packPriceCents ?? null;
    let text = '';
    let usedFallback = false;
    let source: PriceSource = showUnitPrice ? 'unit' : 'pack';
    if (stored != null && size != null && initialLink?.packUnit) {
      // The supplier's OWN saved price always takes priority over any fallback.
      try {
        const shown = quotedPriceCents({
          packPriceExclVatCents: stored,
          basis: showUnitPrice ? 'priced' : 'pack',
          includesVat: inclVat,
          taxRateBps: rate,
          unitsPerPack: units,
          packSize: size,
          packUnit: unit,
          dimension,
        });
        text = shown != null ? centsToAmountInput(shown) : '';
      } catch {
        text = '';
      }
    } else if (currentPriceCents != null && currentPriceCents > 0) {
      // No supplier-specific price yet: prime the calculator from the ingredient's
      // own current price per kg/l/pc so the fields are never both left empty when a
      // usable price is already known. Shown excl. VAT (the stored, canonical basis)
      // and marked as a calculated fallback, never as a confirmed supplier quote.
      text = centsToAmountInput(currentPriceCents);
      source = 'unit';
      usedFallback = true;
    }
    setPriceSource(source);
    setSourceText(text);
    setPriceIsFallback(usedFallback);
    seededFor.current = supplier;
    setBannerError(null);
    setPriceNotice(null);
    setNameAttempted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per open / stored entry
  }, [open, initialLink, dimension, ingredientName, currentPriceCents, notes]);

  // Collapsed each time the editor opens — except Pack & VAT, which starts
  // expanded when the supplier shortcut opened it ("brought into view").
  React.useEffect(() => {
    if (open) {
      setShowPricing(focusSection === 'supplier');
      setShowNotes(false);
    }
  }, [open, focusSection]);

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

  // Picking a different known supplier adopts how that supplier quotes (VAT basis).
  React.useEffect(() => {
    if (!open) return;
    const key = supplierName.trim();
    if (key === '' || key === seededFor.current) return;
    seededFor.current = key;
    const prefs = pricePrefs[key];
    if (prefs?.includesVat != null && !touched.price) setIncludesVat(prefs.includesVat);
  }, [open, supplierName, pricePrefs, touched.price]);

  // Each supplier has its own product name and code for this ingredient: switching
  // supplier shows that supplier's stored ones (blank when not linked yet). Anything
  // the chef already typed is kept and saved against the newly picked supplier.
  function adoptSupplierIdentity(value: string) {
    const key = value.trim();
    if (touched.details || key === identityFor.current) return;
    identityFor.current = key;
    if (initialLink && key === initialLink.supplierName) {
      setProductName(initialLink.supplierProductName ?? '');
      setSku(initialLink.supplierSku ?? '');
      return;
    }
    setProductName('');
    setSku('');
    if (key === '') return;
    void getSupplierProductIdentityAction(ingredientId, key).then((result) => {
      if (!result.ok || !result.data || identityFor.current !== key) return;
      setProductName(result.data.supplierProductName ?? '');
      setSku(result.data.supplierSku ?? '');
    });
  }

  // ── Parsed values; only what was actually typed is validated ─────────────
  const ingredientNameMissing = name.trim() === '';
  const hasSupplier = supplierName.trim() !== '';
  const units = unitsText.trim() === '' ? 1 : parseWholeCount(unitsText);
  const size = sizeText.trim() === '' ? null : parsePositiveDecimal(sizeText);
  const sizeInvalid = sizeText.trim() !== '' && size === null;
  const unitsInvalid = units === null;
  const vatParsed = parseVatPercent(vatText);
  const vatInvalid = vatParsed === 'invalid';
  const vatBps = vatInvalid ? (suggestion?.bps ?? null) : vatParsed;
  const sourceCents = sourceText.trim() === '' ? null : parseMoneyText(sourceText);
  const priceInvalid = sourceText.trim() !== '' && sourceCents === null;
  const directPriceCents = directPriceText.trim() === '' ? null : parseMoneyToCents(directPriceText);
  const directPriceInvalid = directPriceText.trim() !== '' && directPriceCents === null;

  const pack = size !== null && units !== null ? { unitsPerPack: units, packSize: size, packUnit, dimension } : null;
  const derivedCents = pack && sourceCents !== null ? derivePriceCents(priceSource, sourceCents, pack) : null;
  const packCents = priceSource === 'pack' ? sourceCents : derivedCents;
  const unitCents = priceSource === 'unit' ? sourceCents : derivedCents;
  const needsVatForPrice = includesVat && sourceCents !== null && vatBps === null;
  const priceNeedsPack = sourceCents !== null && pack === null;
  const totalLabel = pack ? formatInUnit(pack.unitsPerPack * pack.packSize, packUnit) : null;

  // What the entered price would make the ingredient cost (net, per priced unit).
  let newNetUnitCents: number | null = null;
  const packPriceForCost = packCents;
  if (pack !== null && packPriceForCost !== null) {
    try {
      newNetUnitCents = supplierUnitCost({
        priceCents: packPriceForCost,
        basis: 'pack',
        includesVat,
        taxRateBps: vatBps,
        unitsPerPack: pack.unitsPerPack,
        packSize: pack.packSize,
        packUnit,
        dimension,
      })?.perPricedUnitExclVatCents ?? null;
    } catch {
      newNetUnitCents = null;
    }
  }
  const costDiffers =
    touched.price &&
    !needsVatForPrice &&
    newNetUnitCents !== null &&
    currentPriceCents !== null &&
    currentPriceCents > 0 &&
    newNetUnitCents !== currentPriceCents;

  const vatHint = vatTouched
    ? vatParsed === null
      ? t('vatHint.cleared')
      : null
    : suggestion
      ? t(`vatHint.${suggestion.source}`)
      : t('vatHint.none');

  function editPrice(source: PriceSource, text: string) {
    setPriceSource(source);
    setSourceText(text);
    setPriceIsFallback(false);
    setTouched((prev) => ({ ...prev, price: true }));
    setPriceNotice(null);
  }
  function touchPack() {
    setTouched((prev) => ({ ...prev, pack: true }));
    setPriceNotice(null);
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  function buildSupplierPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { supplierName: supplierName.trim() };
    if (touched.details) {
      payload.supplierProductName = productName.trim();
      payload.supplierSku = sku.trim();
    }
    if (touched.pack) {
      // A mistyped value is left out (the stored one stays) and marked in place.
      if (!unitsInvalid) payload.unitsPerPack = units;
      if (!sizeInvalid) payload.packSize = size;
      payload.packUnit = packUnit;
    }
    // Only a deliberate VAT edit is remembered; a suggested default is not stored.
    if (vatTouched && !vatInvalid) payload.vatRateBps = vatParsed;
    const pricingChanged = touched.price || touched.pack || (vatTouched && includesVat);
    if (pricingChanged && !priceInvalid) {
      payload.packPriceCents = sourceCents;
      payload.priceBasis = priceSource === 'pack' ? 'pack' : 'priced';
      payload.priceIncludesVat = includesVat;
    }
    return payload;
  }

  function save(options?: { clearSupplier?: boolean }) {
    const wantsClear = options?.clearSupplier === true;
    setNameAttempted(true);
    if (ingredientNameMissing) return;
    setBannerError(null);
    setPriceNotice(null);
    startTransition(async () => {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        dimension,
      };
      if (notesTouched) payload.notes = notesText.trim();
      if (wantsClear) {
        payload.clearSupplier = true;
      } else if (hasSupplier) {
        payload.supplier = buildSupplierPayload();
      } else if (directPriceTouched && !directPriceInvalid) {
        payload.priceCents = directPriceCents;
      }

      const result = await updateIngredientEditorAction(ingredientId, payload);
      if (!result.ok) {
        // Everything typed stays in the form so it can be corrected and saved again.
        setBannerError(actionError(result.code));
        return;
      }

      const { ingredient, supplierChange } = result.data;
      let prefs: SupplierPricePrefs | null = null;
      let notice: SupplierSavedNotice | null = null;
      let incomplete = false;
      if (supplierChange.type === 'set') {
        const { priceStatus, link } = supplierChange;
        prefs = { basis: priceSource === 'pack' ? 'pack' : 'priced', includesVat };
        incomplete =
          priceStatus === 'needs_vat' ||
          priceStatus === 'needs_pack' ||
          priceInvalid ||
          sizeInvalid ||
          unitsInvalid ||
          vatInvalid;
        const message =
          priceStatus === 'needs_vat'
            ? t('saved.needsVat')
            : priceStatus === 'needs_pack'
              ? t('saved.needsPack')
              : incomplete
                ? t('saved.partial')
                : supplierChange.priceApplied
                  ? t('saved.priceApplied', {
                      name: link.supplierName,
                      amount: formatMoney(ingredient.priceCents, currency),
                      unit: pricedUnit,
                    })
                  : t('saved.ok', { name: link.supplierName });
        notice = { message, incomplete };
      }

      onSaved({ ingredient, supplierChange, prefs, notice });

      if (incomplete) {
        // The supplier is saved; stay open so the price can be finished.
        setPriceNotice(notice?.message ?? null);
        setShowPricing(true);
        setTouched((prev) => ({ ...prev, details: false }));
      } else {
        onClose();
      }
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

  const basisLabel = includesVat ? t('vat.incl') : t('vat.excl');

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
        <div className="flex flex-col gap-4 overflow-y-auto p-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-ingredient-name`}>{t('ingredientNameLabel')}</Label>
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
            <FieldError
              id={`${id}-ingredient-name-error`}
              message={nameAttempted && ingredientNameMissing ? tIngredients('errors.nameRequired') : null}
            />
          </div>

          {pendingPriceCents != null && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
              <p className="text-amber-800 dark:text-amber-200">
                {t('pendingHint', { amount: formatMoney(pendingPriceCents, currency) })}
              </p>
              <Button type="button" size="sm" onClick={acceptPending} disabled={pending}>
                {t('accept')}
              </Button>
            </div>
          )}

          {bannerError && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
            >
              {bannerError}
            </p>
          )}

          {/* Supplier — optional; leaving it blank saves the ingredient without one. */}
          <div ref={supplierFieldRef} className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('supplierName')}</Label>
            <SupplierPicker
              id={`${id}-name`}
              value={supplierName}
              options={supplierNames}
              disabled={pending}
              invalid={false}
              onChange={(value) => {
                setSupplierName(value);
                adoptSupplierIdentity(value);
              }}
            />
          </div>

          {/* How this supplier names and codes the ingredient — optional, per supplier.
              The routine explanation lives behind an ⓘ popover, not permanently on
              screen (only actual errors / required-to-complete info stay visible). */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`${id}-product`}>{t('productName')}</Label>
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
                setTouched((prev) => ({ ...prev, details: true }));
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-sku`}>{t('sku')}</Label>
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
                setTouched((prev) => ({ ...prev, details: true }));
              }}
            />
          </div>

          {/* The main price field. With no supplier this is a direct, immediate edit
              of the ingredient's approved cost. With a supplier it is THEIR quoted
              price per priced unit — calculated against the pack price below and
              saved through the existing pending/accept safeguard. */}
          {hasSupplier ? (
            <PriceField
              id={`${id}-unit-price`}
              label={t('unitPriceLabel', { unit: pricedUnit, basis: basisLabel })}
              currency={currency}
              value={priceSource === 'unit' ? sourceText : unitCents !== null ? centsToAmountInput(unitCents) : ''}
              calculated={(priceSource === 'unit' && priceIsFallback) || (priceSource !== 'unit' && unitCents !== null)}
              entered={priceSource === 'unit' && sourceText.trim() !== '' && !priceIsFallback}
              invalid={priceSource === 'unit' && priceInvalid}
              disabled={pending}
              calculatedLabel={priceSource === 'unit' && priceIsFallback ? t('fallbackPriceLabel') : t('calculated')}
              fallbackHint={priceSource === 'unit' && priceIsFallback ? t('fallbackPriceHint') : null}
              infoLabel={t('infoLabel')}
              enteredLabel={t('entered')}
              onChange={(text) => editPrice('unit', text)}
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-direct-price`}>{t('directPriceLabel', { unit: pricedUnit })}</Label>
              <div className="relative">
                <Input
                  {...IGNORE_PASSWORD_MANAGERS}
                  id={`${id}-direct-price`}
                  inputMode="decimal"
                  placeholder="—"
                  value={directPriceText}
                  disabled={pending}
                  aria-invalid={directPriceInvalid}
                  className="pr-12 text-right tabular-nums"
                  onChange={(e) => {
                    setDirectPriceText(e.target.value);
                    setDirectPriceTouched(true);
                  }}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  {currency}
                </span>
              </div>
              <FieldError
                id={`${id}-direct-price-error`}
                message={directPriceInvalid ? t('fieldErrors.priceInvalid') : null}
              />
            </div>
          )}

          {/* Pack & VAT — optional, supplier-scoped, and collapsed by default (or
              expanded when opened from the supplier shortcut). Hidden, never
              unmounted or reset, so collapsing keeps every value and unsaved edit. */}
          {hasSupplier && (
            <section className="flex flex-col rounded-xl border border-border">
              <button
                type="button"
                aria-expanded={showPricing}
                aria-controls={`${id}-pricing`}
                onClick={() => setShowPricing((v) => !v)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium hover:bg-surface-2"
              >
                <ChevronDown
                  className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !showPricing && '-rotate-90')}
                  aria-hidden
                />
                <span>{t('packAndPrice')}</span>
                <span className="ml-auto truncate text-xs font-normal text-muted-foreground">
                  {showPricing
                    ? t('optional')
                    : totalLabel && packCents !== null && !priceInvalid
                      ? t('packSummary', { pack: totalLabel, price: formatMoney(packCents, currency), basis: basisLabel })
                      : (totalLabel ?? t('optional'))}
                </span>
              </button>

              <div id={`${id}-pricing`} hidden={!showPricing} className="flex flex-col gap-3 border-t border-border p-3">
                <div className="grid grid-cols-[4.5rem_1fr_6.5rem] gap-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-units`}>{t('unitsPerPack')}</Label>
                    <Input
                      {...IGNORE_PASSWORD_MANAGERS}
                      id={`${id}-units`}
                      inputMode="numeric"
                      value={unitsText}
                      disabled={pending}
                      aria-invalid={unitsInvalid}
                      aria-describedby={unitsInvalid ? `${id}-units-error` : undefined}
                      className="text-right tabular-nums"
                      onChange={(e) => {
                        setUnitsText(e.target.value);
                        touchPack();
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-size`}>{t('packSize')}</Label>
                    <Input
                      {...IGNORE_PASSWORD_MANAGERS}
                      id={`${id}-size`}
                      inputMode="decimal"
                      placeholder={t('optional')}
                      value={sizeText}
                      disabled={pending}
                      aria-invalid={sizeInvalid}
                      aria-describedby={sizeInvalid ? `${id}-size-error` : undefined}
                      className="text-right tabular-nums"
                      onChange={(e) => {
                        setSizeText(e.target.value);
                        touchPack();
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-unit`}>{t('packUnit')}</Label>
                    <Select
                      id={`${id}-unit`}
                      value={packUnit}
                      disabled={pending}
                      onChange={(e) => {
                        setPackUnit(e.target.value as Unit);
                        touchPack();
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
                <FieldError id={`${id}-units-error`} message={unitsInvalid ? t('fieldErrors.unitsInvalid') : null} />
                <FieldError id={`${id}-size-error`} message={sizeInvalid ? t('fieldErrors.packSizeInvalid') : null} />
                {totalLabel && units !== null && units > 1 && (
                  <p className="-mt-1 text-xs text-muted-foreground">{t('packTotal', { total: totalLabel })}</p>
                )}

                <div className="grid grid-cols-[1fr_7rem] gap-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-basis`}>{t('pricesAre')}</Label>
                    <Select
                      id={`${id}-basis`}
                      value={includesVat ? 'incl' : 'excl'}
                      disabled={pending}
                      onChange={(e) => {
                        setIncludesVat(e.target.value === 'incl');
                        setTouched((prev) => ({ ...prev, price: true }));
                      }}
                    >
                      <option value="excl">{t('vat.excl')}</option>
                      <option value="incl">{t('vat.incl')}</option>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor={`${id}-vat`}>{t('vatRate')}</Label>
                      {!vatInvalid && (
                        <InfoPopover label={t('infoLabel')}>
                          <span className="font-medium text-foreground">{t('vatInfoTitle')}</span>
                          <br />
                          {vatHint}
                          {vatBps === 0 && (
                            <>
                              <br />
                              {t('vatRateZero')}
                            </>
                          )}
                        </InfoPopover>
                      )}
                    </div>
                    <div className="relative">
                      <Input
                        {...IGNORE_PASSWORD_MANAGERS}
                        id={`${id}-vat`}
                        inputMode="decimal"
                        placeholder={t('vatRateUnset')}
                        value={vatText}
                        disabled={pending}
                        aria-invalid={vatInvalid}
                        aria-describedby={vatInvalid ? `${id}-vat-error` : undefined}
                        className="pr-7 text-right tabular-nums"
                        onChange={(e) => {
                          setVatText(e.target.value);
                          setVatTouched(true);
                          setPriceNotice(null);
                        }}
                      />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                        %
                      </span>
                    </div>
                  </div>
                </div>
                {/* Only an actual error stays permanently visible — the VAT source
                    explanation moved into the ⓘ popover above, and country-specific
                    preset chips (food / non-food / "No VAT set") are gone: VAT is one
                    editable rate plus the incl./excl. selector, never a guessed rate. */}
                <FieldError id={`${id}-vat-error`} message={vatInvalid ? t('vatRateInvalid') : null} />

                <PriceField
                  id={`${id}-pack-price`}
                  label={t('packPriceLabel', { basis: basisLabel })}
                  currency={currency}
                  value={priceSource === 'pack' ? sourceText : packCents !== null ? centsToAmountInput(packCents) : ''}
                  calculated={priceSource !== 'pack' && packCents !== null}
                  entered={priceSource === 'pack' && sourceText.trim() !== ''}
                  invalid={priceSource === 'pack' && priceInvalid}
                  disabled={pending}
                  calculatedLabel={t('calculated')}
                  enteredLabel={t('entered')}
                  onChange={(text) => editPrice('pack', text)}
                />
                <FieldError id={`${id}-price-error`} message={priceInvalid ? t('fieldErrors.priceInvalid') : null} />
                {priceNeedsPack && !priceInvalid && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">{t('priceNeedsPack', { unit: pricedUnit })}</p>
                )}
                {needsVatForPrice && <p className="text-xs text-amber-700 dark:text-amber-300">{t('priceNeedsVat')}</p>}

                <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
                  <p>
                    {currentPriceCents !== null && currentPriceCents > 0
                      ? t('currentCost', { amount: formatMoney(currentPriceCents, currency), unit: pricedUnit })
                      : t('currentCostUnknown')}
                  </p>
                  {costDiffers && newNetUnitCents !== null && (
                    <p className="mt-1 text-amber-800 dark:text-amber-300">
                      {t('costWillBePending', { amount: formatMoney(newNetUnitCents, currency), unit: pricedUnit })}
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Notes — free text, optional, collapsed by default. Hidden, never
              unmounted or reset, so collapsing keeps any unsaved edit. */}
          <section className="flex flex-col rounded-xl border border-border">
            <button
              type="button"
              aria-expanded={showNotes}
              aria-controls={`${id}-notes`}
              onClick={() => setShowNotes((v) => !v)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium hover:bg-surface-2"
            >
              <ChevronDown
                className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !showNotes && '-rotate-90')}
                aria-hidden
              />
              <span>{t('notes.title')}</span>
              {(notesTouched ? notesText : (notes ?? '')).trim() !== '' && (
                <span className="ml-auto truncate text-xs font-normal text-muted-foreground">{t('notes.added')}</span>
              )}
            </button>
            <div id={`${id}-notes`} hidden={!showNotes} className="flex flex-col gap-1.5 border-t border-border p-3">
              <Label htmlFor={`${id}-notes-field`}>{t('notes.title')}</Label>
              <Textarea
                id={`${id}-notes-field`}
                placeholder={t('notes.placeholder')}
                value={notesText}
                disabled={pending}
                rows={3}
                onChange={(e) => {
                  setNotesText(e.target.value);
                  setNotesTouched(true);
                }}
              />
            </div>
          </section>
        </div>

        {/* Save stays in reach at the bottom of the dialog. */}
        <div className="flex flex-col gap-2 border-t border-border px-5 py-3">
          {priceNotice && (
            <p role="status" className="text-sm text-amber-800 dark:text-amber-300">
              {priceNotice}
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
                {priceNotice ? t('done') : t('cancel')}
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

function PriceField({
  id,
  label,
  currency,
  value,
  calculated,
  entered,
  invalid,
  disabled,
  calculatedLabel,
  enteredLabel,
  fallbackHint = null,
  infoLabel,
  onChange,
}: {
  id: string;
  label: string;
  currency: string;
  value: string;
  calculated: boolean;
  entered: boolean;
  invalid: boolean;
  disabled: boolean;
  calculatedLabel: string;
  enteredLabel: string;
  /** Set to distinguish a calculated FALLBACK (not yet confirmed) from a plain derived value. */
  fallbackHint?: string | null;
  infoLabel?: string;
  onChange: (text: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {calculated ? (
          <span className="flex items-center gap-1">
            <span className="rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-medium text-accent-800 dark:bg-accent-500/15 dark:text-accent-200">
              {calculatedLabel}
            </span>
            {fallbackHint && <InfoPopover label={infoLabel ?? calculatedLabel}>{fallbackHint}</InfoPopover>}
          </span>
        ) : entered ? (
          <span className="text-[11px] text-muted-foreground">{enteredLabel}</span>
        ) : null}
      </div>
      <div className="relative">
        <Input
          {...IGNORE_PASSWORD_MANAGERS}
          id={id}
          inputMode="decimal"
          placeholder="—"
          value={value}
          disabled={disabled}
          aria-invalid={invalid}
          className={cn('pr-12 text-right tabular-nums', calculated && 'bg-accent-50/50 dark:bg-accent-500/10')}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {currency}
        </span>
      </div>
    </div>
  );
}
