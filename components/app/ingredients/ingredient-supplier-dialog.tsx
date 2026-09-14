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
import { centsToAmountInput, formatMoney } from '@/lib/format/money';
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
import {
  acceptPendingCostAction,
  clearIngredientSupplierAction,
  setIngredientSupplierAction,
} from '@/app/(app)/ingredients/actions';
import type { DefaultSupplierSummary } from '@/lib/data/ingredient-suppliers';
import type { SupplierPricePrefs, VatCategoryOption } from '@/components/app/ingredients/ingredient-grid';

/**
 * Ingredient supplier editor (manager-only; the server is the real gate).
 *
 * Supplier first, pricing optional: pick a supplier and Save — nothing else is
 * required. Pack, price and VAT can be completed later, one at a time; a part left
 * as it was keeps its stored value, a cleared field is stored as unknown (never 0),
 * and a typo is marked beside its field without blocking the supplier.
 *
 * Prices work in either direction on ONE VAT basis: type the pack price or the price
 * per kg / litre / piece and the other is calculated (and labelled so). The last
 * price typed is the source; changing the pack keeps it and recalculates the other.
 * VAT is suggested from what the system already knows (this entry → the ingredient
 * → the business's default purchase VAT) and applied once, on the server, when an
 * incl.-VAT price is stored as the net pack price. The supplier's product name and
 * code stay purchasing-only.
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
  supplierNames,
  pricePrefs,
  initialLink,
  currentPriceCents,
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
  /** VAT bands — offered as one-click shortcuts only. */
  vatCategories: VatCategoryOption[];
  /** The ingredient's explicitly chosen VAT band (legacy); null = none. */
  vatCategoryId: string | null;
  /** The ingredient's own purchase VAT (bps); null = not set. */
  vatRateBps: number | null;
  /** The business's configured default purchase VAT (bps); null = none. */
  businessPurchaseVatBps: number | null;
  supplierNames: string[];
  pricePrefs: Record<string, SupplierPricePrefs>;
  initialLink: DefaultSupplierSummary | null;
  /** The ingredient's approved cost per priced unit (excl. VAT). */
  currentPriceCents: number | null;
  pendingPriceCents: number | null;
  onClose: () => void;
  onSaved: (summary: DefaultSupplierSummary, prefs: SupplierPricePrefs, notice: SupplierSavedNotice) => void;
  onCleared: () => void;
  onAccepted: (priceCents: number) => void;
}) {
  const t = useTranslations('suppliers.ingredientEditor');
  const actionError = useActionError();
  const ref = React.useRef<HTMLDialogElement>(null);
  const id = React.useId();
  const pricedUnit = PRICED_UNIT_LABEL[dimension];

  const bandBps = vatCategories.find((c) => c.id === ingredientBandId)?.rateBps ?? null;
  const unitOptions = React.useMemo(() => PACK_UNITS.filter((u) => dimensionOf(u) === dimension), [dimension]);
  const vatShortcuts = React.useMemo(
    () => [...new Map(vatCategories.map((c) => [c.rateBps, c])).values()],
    [vatCategories],
  );

  // ── Form state ────────────────────────────────────────────────────────────
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
  /** Which parts were changed — untouched parts aren't sent, so the server keeps them. */
  const [touched, setTouched] = React.useState({ pack: false, price: false, details: false });
  const [showDetails, setShowDetails] = React.useState(false);
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
  });

  // Re-seed from what is stored whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const name = initialLink?.supplierName ?? '';
    const units = initialLink?.unitsPerPack ?? 1;
    const size = initialLink?.packSize ?? null;
    const unit = (initialLink?.packUnit as Unit | null) ?? DEFAULT_PACK_UNIT[dimension];
    const rate = suggestion?.bps ?? null;
    const prefs = pricePrefs[name];
    // A supplier who quotes incl. VAT is shown that way only while a rate is known.
    const inclVat = (prefs?.includesVat ?? false) && rate != null;
    const showUnitPrice = prefs?.basis === 'priced';

    setSupplierName(name);
    setProductName(initialLink?.supplierProductName ?? '');
    setSku(initialLink?.supplierSku ?? '');
    setShowDetails(Boolean(initialLink?.supplierProductName || initialLink?.supplierSku));
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
    if (stored != null && size != null && initialLink?.packUnit) {
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
    }
    setPriceSource(showUnitPrice ? 'unit' : 'pack');
    setSourceText(text);
    seededFor.current = name;
    setBannerError(null);
    setPriceNotice(null);
    setNameAttempted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per open / stored entry
  }, [open, initialLink, dimension]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // Picking a different known supplier adopts how that supplier quotes (VAT basis).
  React.useEffect(() => {
    if (!open) return;
    const key = supplierName.trim();
    if (key === '' || key === seededFor.current) return;
    seededFor.current = key;
    const prefs = pricePrefs[key];
    if (prefs?.includesVat != null && !touched.price) setIncludesVat(prefs.includesVat);
  }, [open, supplierName, pricePrefs, touched.price]);

  // ── Parsed values; only what was actually typed is validated ─────────────
  const units = unitsText.trim() === '' ? 1 : parseWholeCount(unitsText);
  const size = sizeText.trim() === '' ? null : parsePositiveDecimal(sizeText);
  const sizeInvalid = sizeText.trim() !== '' && size === null;
  const unitsInvalid = units === null;
  const vatParsed = parseVatPercent(vatText);
  const vatInvalid = vatParsed === 'invalid';
  const vatBps = vatInvalid ? (suggestion?.bps ?? null) : vatParsed;
  const sourceCents = sourceText.trim() === '' ? null : parseMoneyText(sourceText);
  const priceInvalid = sourceText.trim() !== '' && sourceCents === null;

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

  const nameMissing = supplierName.trim() === '';
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
    setTouched((prev) => ({ ...prev, price: true }));
    setPriceNotice(null);
  }
  function touchPack() {
    setTouched((prev) => ({ ...prev, pack: true }));
    setPriceNotice(null);
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  function buildPayload(): Record<string, unknown> {
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

  function save() {
    setNameAttempted(true);
    if (nameMissing) return;
    setBannerError(null);
    setPriceNotice(null);
    startTransition(async () => {
      const result = await setIngredientSupplierAction(ingredientId, buildPayload());
      if (!result.ok) {
        // Everything typed stays in the form so it can be corrected and saved again.
        setBannerError(actionError(result.code));
        return;
      }
      const prefs: SupplierPricePrefs = { basis: priceSource === 'pack' ? 'pack' : 'priced', includesVat };
      const { priceStatus, link, pendingRaised } = result.data;
      const incomplete =
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
              : pendingRaised
                ? t('saved.pending', { name: link.supplierName })
                : t('saved.ok', { name: link.supplierName });
      onSaved(link, prefs, { message, incomplete });
      if (incomplete) {
        // The supplier is saved; stay open so the price can be finished.
        setPriceNotice(message);
        setTouched((prev) => ({ ...prev, details: false }));
      } else {
        onClose();
      }
    });
  }

  function clearSupplier() {
    setBannerError(null);
    startTransition(async () => {
      const result = await clearIngredientSupplierAction(ingredientId);
      if (result.ok) {
        onCleared();
        onClose();
      } else {
        setBannerError(actionError(result.code));
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
          <div className="flex flex-col gap-0.5">
            <h2 id={`${id}-title`} className="font-display text-lg font-semibold">
              {t('heading')}
            </h2>
            <p className="text-sm text-muted-foreground">{ingredientName}</p>
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

          {/* Supplier — the only thing needed to save. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('supplierName')}</Label>
            <SupplierPicker
              id={`${id}-name`}
              value={supplierName}
              options={supplierNames}
              disabled={pending}
              invalid={nameAttempted && nameMissing}
              describedBy={nameAttempted && nameMissing ? `${id}-name-error` : undefined}
              onChange={(name) => {
                setSupplierName(name);
                setNameAttempted(false);
              }}
            />
            <FieldError
              id={`${id}-name-error`}
              message={nameAttempted && nameMissing ? t('fieldErrors.supplierRequired') : null}
            />
          </div>

          {/* Pricing — optional, can be completed later. */}
          <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">{t('pricingOptional')}</legend>

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
                <Label htmlFor={`${id}-vat`}>{t('vatRate')}</Label>
                <div className="relative">
                  <Input
                    {...IGNORE_PASSWORD_MANAGERS}
                    id={`${id}-vat`}
                    inputMode="decimal"
                    placeholder={t('vatRateUnset')}
                    value={vatText}
                    disabled={pending}
                    aria-invalid={vatInvalid}
                    aria-describedby={`${id}-vat-hint`}
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
            <div id={`${id}-vat-hint`} className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {vatInvalid ? (
                <span className="text-red-700 dark:text-red-300">{t('vatRateInvalid')}</span>
              ) : (
                <>
                  {vatHint && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted-foreground">{vatHint}</span>}
                  {vatBps === 0 && <span className="text-muted-foreground">{t('vatRateZero')}</span>}
                </>
              )}
              {vatShortcuts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setVatText(String(c.rateBps / 100));
                    setVatTouched(true);
                  }}
                  className="cursor-pointer rounded-full border border-border px-2 py-0.5 tabular-nums text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                >
                  {t('vatCategoryOption', { name: c.name, rate: String(c.rateBps / 100) })}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
              <PriceField
                id={`${id}-unit-price`}
                label={t('unitPriceLabel', { unit: pricedUnit, basis: basisLabel })}
                currency={currency}
                value={priceSource === 'unit' ? sourceText : unitCents !== null ? centsToAmountInput(unitCents) : ''}
                calculated={priceSource !== 'unit' && unitCents !== null}
                entered={priceSource === 'unit' && sourceText.trim() !== ''}
                invalid={priceSource === 'unit' && priceInvalid}
                disabled={pending}
                calculatedLabel={t('calculated')}
                enteredLabel={t('entered')}
                onChange={(text) => editPrice('unit', text)}
              />
            </div>
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
          </fieldset>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((v) => !v)}
              className="inline-flex w-fit cursor-pointer items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={cn('size-4 transition-transform', !showDetails && '-rotate-90')} aria-hidden />
              {t('moreDetails')}
            </button>
            {showDetails && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-product`}>{t('productName')}</Label>
                  <Input
                    {...IGNORE_PASSWORD_MANAGERS}
                    id={`${id}-product`}
                    placeholder={t('productNamePlaceholder')}
                    value={productName}
                    disabled={pending}
                    onChange={(e) => {
                      setProductName(e.target.value);
                      setTouched((prev) => ({ ...prev, details: true }));
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-sku`}>{t('sku')}</Label>
                  <Input
                    {...IGNORE_PASSWORD_MANAGERS}
                    id={`${id}-sku`}
                    placeholder={t('skuPlaceholder')}
                    value={sku}
                    disabled={pending}
                    onChange={(e) => {
                      setSku(e.target.value);
                      setTouched((prev) => ({ ...prev, details: true }));
                    }}
                  />
                </div>
              </div>
            )}
          </div>
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
              <Button type="button" variant="ghost" onClick={clearSupplier} disabled={pending}>
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
  onChange: (text: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {calculated ? (
          <span className="rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-medium text-accent-800 dark:bg-accent-500/15 dark:text-accent-200">
            {calculatedLabel}
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
