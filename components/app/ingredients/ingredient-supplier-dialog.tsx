'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { IGNORE_PASSWORD_MANAGERS, Input } from '@/components/ui/input';
import { SupplierPicker } from '@/components/app/ingredients/supplier-picker';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useActionError } from '@/lib/i18n/use-action-error';
import { centsToAmountInput, formatMoney, parseMoneyToCents } from '@/lib/format/money';
import {
  dimensionOf,
  formatInUnit,
  PRICED_UNIT_LABEL,
  unitLabel,
  type Dimension,
  type Unit,
} from '@/lib/units';
import {
  quotedPriceCents,
  supplierUnitCost,
  type SupplierPriceBasis,
} from '@/lib/calculations/purchasePrice';
import { PACK_UNITS, PRICE_BASES } from '@/lib/validation/suppliers';
import { parseVatPercent } from '@/lib/validation/vat-rate';
import {
  isPackBlockingSave,
  validateSupplierPackForm,
  type SupplierPackFormErrors,
} from '@/lib/validation/supplier-pack-form';
import {
  acceptPendingCostAction,
  clearIngredientSupplierAction,
  setIngredientSupplierAction,
} from '@/app/(app)/ingredients/actions';
import type { DefaultSupplierSummary } from '@/lib/data/ingredient-suppliers';
import type {
  SupplierPricePrefs,
  VatCategoryOption,
} from '@/components/app/ingredients/ingredient-grid';

/**
 * Set the DEFAULT supplier + purchase pack on one ingredient (Sprint 7),
 * MANAGER-ONLY (the grid only mounts it for cost-seeing managers; the server is
 * the real gate).
 *
 * The dialog asks TWO QUESTIONS and gives ONE ANSWER:
 *   • what you buy    — units × pack size + unit (a 4 × 1,65 kg case)
 *   • what they charge — the quoted price, plus how to read it (per pack / per
 *     unit / per kg, excl. or incl. VAT)
 *   • the answer      — the live cost per priced unit. That number is the safety
 *     net: forget the case quantity and it jumps 4×, before it reaches a recipe.
 *
 * The supplier's PRODUCT NAME lives here and only here — purchasing sees it,
 * recipes and menus never do. Native `<dialog>`, mirroring the allergen editor.
 */

/**
 * One inline message, under the field it belongs to. Rendering nothing when there
 * is nothing to say keeps the form's height stable on the happy path.
 */
function FieldError({ id, message }: { id?: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

/** Red hairline on the offending control, so the message has something to point at. */
function errorRing(message: string | null): string | undefined {
  return message ? 'border-red-400 dark:border-red-500/60' : undefined;
}

/** Pack unit pre-filled from the ingredient's own dimension (the common case). */
const DEFAULT_PACK_UNIT: Record<Dimension, Unit> = {
  weight: 'kg',
  volume: 'l',
  count: 'count',
};

export function IngredientSupplierDialog({
  open,
  ingredientId,
  ingredientName,
  dimension,
  currency,
  vatCategories,
  vatCategoryId: initialVatCategoryId,
  vatRateBps: initialVatRateBps,
  supplierNames,
  pricePrefs,
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
  /** The org's purchase VAT bands; empty = none configured (no gross entry). */
  vatCategories: VatCategoryOption[];
  /** The ingredient's legacy band; null = fall back to the org's default band. */
  vatCategoryId: string | null;
  /** The ingredient's own typed VAT rate (bps); null = not set (band / default). */
  vatRateBps: number | null;
  /** Existing supplier names for the picker (manager's active suppliers). */
  supplierNames: string[];
  /** Remembered price-entry mode per supplier NAME, so the selects prefill. */
  pricePrefs: Record<string, SupplierPricePrefs>;
  initialLink: DefaultSupplierSummary | null;
  pendingPriceCents: number | null;
  onClose: () => void;
  onSaved: (
    summary: DefaultSupplierSummary,
    prefs: SupplierPricePrefs,
    vatRateBps: number | null,
  ) => void;
  onCleared: () => void;
  onAccepted: (priceCents: number) => void;
}) {
  const t = useTranslations('suppliers.ingredientEditor');
  const actionError = useActionError();
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();

  const [supplierName, setSupplierName] = React.useState('');
  const [productName, setProductName] = React.useState('');
  const [sku, setSku] = React.useState('');
  const [unitsPerPack, setUnitsPerPack] = React.useState('1');
  const [packSize, setPackSize] = React.useState('');
  const [packUnit, setPackUnit] = React.useState<Unit | ''>('');
  const [packPriceText, setPackPriceText] = React.useState('');
  const [basis, setBasis] = React.useState<SupplierPriceBasis>('pack');
  const [includesVat, setIncludesVat] = React.useState(false);
  // The ingredient's purchase VAT rate as typed (percent). '' = not set → the
  // ingredient's band, else the org's default band. '0' is a deliberate 0% rate.
  const [vatText, setVatText] = React.useState('');
  // The stored price is the whole pack EXCL. VAT; what we show is that value
  // converted into the supplier's quoting mode, which can differ by a cent on the
  // round trip. So while the manager hasn't touched any pricing control we send the
  // STORED cents straight back — opening and saving a link never moves the price.
  const [priceTouched, setPriceTouched] = React.useState(false);
  // The top banner now carries ONLY server-returned codes (VAT_RATE_REQUIRED,
  // SUPPLIER_INACTIVE, …). Anything the form can see for itself is reported
  // inline, next to the field that is wrong.
  const [bannerError, setBannerError] = React.useState<string | null>(null);
  // A supplier name is missing on every fresh form, so its inline error waits for
  // the first Save rather than greeting the manager in red.
  const [saveAttempted, setSaveAttempted] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // The supplier whose quoting mode is currently loaded, so switching supplier
  // re-seeds the two selects exactly once instead of on every keystroke.
  const seededFor = React.useRef<string | null>(null);

  // Pack units valid for this ingredient's dimension (PACK_UNIT_MISMATCH otherwise).
  const unitOptions = React.useMemo(
    () => PACK_UNITS.filter((u) => dimensionOf(u) === dimension),
    [dimension],
  );
  const pricedUnit = PRICED_UNIT_LABEL[dimension];

  /**
   * The rate that converts this quote: the typed rate when set, else the
   * ingredient's band, else the org's default band. The server resolves it the
   * same way from what is saved.
   */
  const fallbackCategory =
    vatCategories.find((c) => c.id === initialVatCategoryId) ??
    vatCategories.find((c) => c.isDefault) ??
    null;
  const vatParsed = parseVatPercent(vatText);
  const vatInvalid = vatParsed === 'invalid';
  const ownRateBps = vatParsed === 'invalid' ? null : vatParsed;
  const taxRateBps = ownRateBps ?? fallbackCategory?.rateBps ?? null;
  const presetRates = React.useMemo(() => {
    const seen = new Set<number>();
    return vatCategories.filter((c) => (seen.has(c.rateBps) ? false : (seen.add(c.rateBps), true)));
  }, [vatCategories]);

  // Re-seed from the current link whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const name = initialLink?.supplierName ?? '';
    const prefs = pricePrefs[name];
    const seedBasis = prefs?.basis ?? 'pack';
    // Seed the rate from the ingredient's stored band, NOT from the derived
    // `taxRateBps` — that changes as the manager picks a band, and depending on it
    // here would re-seed (and wipe) the whole form on every VAT change.
    const seedRateBps =
      initialVatRateBps ??
      (vatCategories.find((c) => c.id === initialVatCategoryId) ??
        vatCategories.find((c) => c.isDefault))?.rateBps ??
      null;
    // A gross-quoting supplier is only honoured while a rate exists to strip.
    const seedInclVat = (prefs?.includesVat ?? false) && seedRateBps != null;
    const units = initialLink?.unitsPerPack ?? 1;
    const size = initialLink?.packSize ?? null;
    const unit = (initialLink?.packUnit as Unit | null) ?? null;

    setSupplierName(name);
    setProductName(initialLink?.supplierProductName ?? '');
    setSku(initialLink?.supplierSku ?? '');
    setUnitsPerPack(String(units));
    setPackSize(size != null ? String(size) : '');
    setPackUnit(unit ?? DEFAULT_PACK_UNIT[dimension]);
    setBasis(seedBasis);
    setIncludesVat(seedInclVat);
    setVatText(initialVatRateBps != null ? String(initialVatRateBps / 100) : '');
    // Show the stored net pack price back in the supplier's quoting mode.
    const stored = initialLink?.packPriceCents ?? null;
    const shown =
      stored != null && size != null && unit != null
        ? quotedPriceCents({
            packPriceExclVatCents: stored,
            basis: seedBasis,
            includesVat: seedInclVat,
            taxRateBps: seedRateBps,
            unitsPerPack: units,
            packSize: size,
            packUnit: unit,
            dimension,
          })
        : null;
    setPackPriceText(shown != null ? centsToAmountInput(shown) : '');
    setPriceTouched(false);
    // This supplier's mode is already loaded — don't let the switch effect below
    // treat the initial name as a change and mark the price touched.
    seededFor.current = name;
    setBannerError(null);
    setSaveAttempted(false);
  }, [open, initialLink, pricePrefs, dimension, vatCategories, initialVatCategoryId, initialVatRateBps]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  // Typing/picking a DIFFERENT known supplier adopts that supplier's remembered
  // quoting mode. Keyed on the name so it fires once per supplier, not per keystroke.
  React.useEffect(() => {
    if (!open) return;
    const key = supplierName.trim();
    if (key === '' || key === seededFor.current) return;
    const prefs = pricePrefs[key];
    seededFor.current = key;
    if (!prefs) return;
    if (prefs.basis) setBasis(prefs.basis);
    if (prefs.includesVat != null) setIncludesVat(prefs.includesVat && taxRateBps != null);
    setPriceTouched(true);
  }, [open, supplierName, pricePrefs, taxRateBps]);

  /** Any pricing control the manager touches invalidates the send-stored shortcut. */
  const touchPrice = React.useCallback(() => setPriceTouched(true), []);

  // Parsed pack, shared by the live readout and the save payload.
  const sizeNum = packSize.trim() === '' ? Number.NaN : Number(packSize);
  const unitsNum = unitsPerPack.trim() === '' ? Number.NaN : Number(unitsPerPack);
  const hasSize = Number.isFinite(sizeNum) && sizeNum > 0;
  const hasUnits = Number.isInteger(unitsNum) && unitsNum > 0;
  const unit = packUnit === '' ? null : packUnit;

  /**
   * "6.6 kg" — the quantity one purchase actually brings in. `formatInUnit`
   * already appends the unit label; appending it again is what produced "25 kg kg".
   */
  const totalLabel = hasSize && hasUnits && unit ? formatInUnit(unitsNum * sizeNum, unit) : null;

  /** The one number that matters: cost per kg / litre / piece. */
  const readout = React.useMemo(() => {
    if (!hasSize || !hasUnits || !unit || packPriceText.trim() === '') return null;
    try {
      return supplierUnitCost({
        priceCents: parseMoneyToCents(packPriceText),
        basis,
        includesVat,
        taxRateBps,
        unitsPerPack: unitsNum,
        packSize: sizeNum,
        packUnit: unit,
        dimension,
      });
    } catch {
      // An impossible pack (NaN/0 after conversion) — the readout just stays empty.
      return null;
    }
  }, [
    hasSize,
    hasUnits,
    unit,
    packPriceText,
    basis,
    includesVat,
    taxRateBps,
    unitsNum,
    sizeNum,
    dimension,
  ]);

  /**
   * Field-level validation, live. Pure and unit-tested in
   * `tests/supplier-pack-form.test.ts` — it is the rule most likely to drift, and
   * it decides whether Save is clickable at all.
   */
  const fieldErrors: SupplierPackFormErrors = React.useMemo(
    () =>
      validateSupplierPackForm({
        supplierName,
        unitsPerPack,
        packSize,
        packUnit,
        packPrice: packPriceText,
      }),
    [supplierName, unitsPerPack, packSize, packUnit, packPriceText],
  );

  /**
   * Save is dead ONLY on a half-described pack — a state the manager created and
   * can see marked. A name-only link still saves (decision D1).
   */
  const saveBlocked = isPackBlockingSave(fieldErrors);

  /** Inline message for a field, or null when it has nothing to say yet. */
  const fieldError = (field: keyof SupplierPackFormErrors): string | null => {
    const code = fieldErrors[field];
    if (!code) return null;
    // Pack errors only exist once the manager typed a size or a price, so they
    // are always self-inflicted and safe to show immediately. The name error is
    // the one that would fire on an untouched form.
    if (field === 'supplierName' && !saveAttempted) return null;
    return t(`fieldErrors.${code}`);
  };

  const onSave = () => {
    setSaveAttempted(true);
    const name = supplierName.trim();
    if (name === '' || saveBlocked || vatInvalid) return;
    const priceCents =
      packPriceText.trim() === '' ? undefined : parseMoneyToCents(packPriceText);

    // Untouched pricing → replay the stored whole-pack net price verbatim (and leave
    // the supplier's remembered mode alone by omitting both hints).
    const keepStored =
      !priceTouched && initialLink?.packPriceCents != null && priceCents !== undefined;
    const pricePart = keepStored
      ? { packPriceCents: initialLink.packPriceCents as number }
      : priceCents !== undefined
        ? {
            packPriceCents: priceCents,
            priceBasis: basis,
            priceIncludesVat: includesVat,
          }
        : {};

    const input = {
      supplierName: name,
      ...(productName.trim() ? { supplierProductName: productName.trim() } : {}),
      ...(sku.trim() ? { supplierSku: sku.trim() } : {}),
      ...(hasSize ? { packSize: sizeNum } : {}),
      ...(unit ? { packUnit: unit } : {}),
      ...(hasUnits ? { unitsPerPack: unitsNum } : {}),
      // Always sent (null = not set) so clearing the rate is a real edit, not an
      // omission the server would read as "leave it alone".
      vatRateBps: ownRateBps,
      ...pricePart,
    };

    setBannerError(null);
    startTransition(async () => {
      const result = await setIngredientSupplierAction(ingredientId, input);
      if (result.ok) {
        onSaved(
          {
            supplierName: name,
            packSize: hasSize ? sizeNum : null,
            packUnit: unit,
            // What the server stored: the whole pack, excl. VAT.
            packPriceCents: keepStored
              ? (initialLink.packPriceCents as number)
              : (readout?.packPriceExclVatCents ?? null),
            unitsPerPack: hasUnits ? unitsNum : 1,
            supplierProductName: productName.trim() || null,
            supplierSku: sku.trim() || null,
          },
          { basis, includesVat },
          ownRateBps,
        );
        onClose();
      } else {
        setBannerError(actionError(result.code));
      }
    });
  };

  const onClear = () => {
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
  };

  const onAccept = () => {
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
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-surface p-0 text-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-5">
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

        {bannerError && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            {bannerError}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${titleId}-name`}>{t('supplierName')}</Label>
          <SupplierPicker
            id={`${titleId}-name`}
            value={supplierName}
            options={supplierNames}
            disabled={pending}
            invalid={fieldError('supplierName') != null}
            describedBy={
              fieldError('supplierName') != null ? `${titleId}-name-error` : undefined
            }
            onChange={setSupplierName}
          />
          <FieldError id={`${titleId}-name-error`} message={fieldError('supplierName')} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${titleId}-product`}>{t('productName')}</Label>
          <Input
            {...IGNORE_PASSWORD_MANAGERS}
            id={`${titleId}-product`}
            placeholder={t('productNamePlaceholder')}
            value={productName}
            disabled={pending}
            onChange={(e) => setProductName(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('productNameHint')}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${titleId}-sku`}>{t('sku')}</Label>
          <Input
            {...IGNORE_PASSWORD_MANAGERS}
            id={`${titleId}-sku`}
            placeholder={t('skuPlaceholder')}
            value={sku}
            disabled={pending}
            onChange={(e) => setSku(e.target.value)}
          />
        </div>

        {/* ── What you buy ───────────────────────────────────────────────── */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('buySectionTitle')}
          </legend>
          <div className="grid grid-cols-[4.5rem_1fr_7rem] gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${titleId}-units`}>{t('unitsPerPack')}</Label>
              <Input
                {...IGNORE_PASSWORD_MANAGERS}
                id={`${titleId}-units`}
                inputMode="numeric"
                value={unitsPerPack}
                disabled={pending}
                aria-invalid={fieldError('unitsPerPack') != null}
                aria-describedby={
                  fieldError('unitsPerPack') != null ? `${titleId}-units-error` : undefined
                }
                className={errorRing(fieldError('unitsPerPack'))}
                onChange={(e) => {
                  setUnitsPerPack(e.target.value);
                  touchPrice();
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${titleId}-size`}>{t('packSize')}</Label>
              <Input
                {...IGNORE_PASSWORD_MANAGERS}
                id={`${titleId}-size`}
                inputMode="decimal"
                placeholder="0"
                value={packSize}
                disabled={pending}
                aria-invalid={fieldError('packSize') != null}
                aria-describedby={
                  fieldError('packSize') != null ? `${titleId}-size-error` : undefined
                }
                className={errorRing(fieldError('packSize'))}
                onChange={(e) => {
                  setPackSize(e.target.value);
                  touchPrice();
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${titleId}-unit`}>{t('packUnit')}</Label>
              <Select
                id={`${titleId}-unit`}
                value={packUnit}
                disabled={pending}
                aria-invalid={fieldError('packUnit') != null}
                aria-describedby={
                  fieldError('packUnit') != null ? `${titleId}-unit-error` : undefined
                }
                className={errorRing(fieldError('packUnit'))}
                onChange={(e) => {
                  setPackUnit(e.target.value as Unit | '');
                  touchPrice();
                }}
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
          <FieldError id={`${titleId}-units-error`} message={fieldError('unitsPerPack')} />
          <FieldError id={`${titleId}-size-error`} message={fieldError('packSize')} />
          <FieldError id={`${titleId}-unit-error`} message={fieldError('packUnit')} />
          {totalLabel && (
            <p className="text-xs text-muted-foreground">
              {t('packTotal', { total: totalLabel })}
            </p>
          )}
        </fieldset>

        {/* ── What the supplier charges ──────────────────────────────────── */}
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('chargeSectionTitle')}
          </legend>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${titleId}-price`}>
                {t('packPrice')} · {currency}
              </Label>
              <Input
                {...IGNORE_PASSWORD_MANAGERS}
                id={`${titleId}-price`}
                inputMode="decimal"
                placeholder="0.00"
                value={packPriceText}
                disabled={pending}
                aria-invalid={fieldError('packPrice') != null}
                aria-describedby={
                  fieldError('packPrice') != null ? `${titleId}-price-error` : undefined
                }
                className={errorRing(fieldError('packPrice'))}
                onChange={(e) => {
                  setPackPriceText(e.target.value);
                  touchPrice();
                }}
              />
              <FieldError id={`${titleId}-price-error`} message={fieldError('packPrice')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${titleId}-basis`}>{t('priceBasis')}</Label>
              <Select
                id={`${titleId}-basis`}
                className="w-32"
                value={basis}
                disabled={pending}
                onChange={(e) => {
                  setBasis(e.target.value as SupplierPriceBasis);
                  touchPrice();
                }}
              >
                {PRICE_BASES.map((b) => (
                  <option key={b} value={b}>
                    {t(`basis.${b}`, { unit: pricedUnit })}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${titleId}-vat`}>{t('vatBasis')}</Label>
              <Select
                id={`${titleId}-vat`}
                value={includesVat ? 'incl' : 'excl'}
                // Without a resolvable rate there is no way to strip VAT back out,
                // so gross entry stays closed rather than silently assuming 0%.
                disabled={pending || taxRateBps == null}
                onChange={(e) => {
                  setIncludesVat(e.target.value === 'incl');
                  touchPrice();
                }}
              >
                <option value="excl">{t('vat.excl')}</option>
                <option value="incl">{t('vat.incl')}</option>
              </Select>
            </div>
            {/*
              VAT on a PURCHASE depends on the goods and the country, so the rate is
              typed here per ingredient — any rate, including 0% and decimals. The
              org's bands are only shortcuts that fill the field.
            */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${titleId}-vatrate`}>{t('vatRate')}</Label>
              <div className="relative w-32">
                <Input
                  id={`${titleId}-vatrate`}
                  inputMode="decimal"
                  {...IGNORE_PASSWORD_MANAGERS}
                  value={vatText}
                  placeholder={
                    fallbackCategory ? String(fallbackCategory.rateBps / 100) : t('vatRateUnset')
                  }
                  aria-invalid={vatInvalid}
                  aria-describedby={`${titleId}-vatrate-hint`}
                  disabled={pending}
                  onChange={(e) => {
                    setVatText(e.target.value);
                    touchPrice();
                  }}
                  className={cn('pr-8 text-right tabular-nums', errorRing(vatInvalid ? 'x' : null))}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  %
                </span>
              </div>
            </div>
          </div>
          {presetRates.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t('vatPresets')}</span>
              {presetRates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={pending}
                  aria-pressed={ownRateBps === c.rateBps}
                  onClick={() => {
                    setVatText(String(c.rateBps / 100));
                    touchPrice();
                  }}
                  className={cn(
                    'cursor-pointer rounded-full border px-2.5 py-1 text-xs tabular-nums transition-colors',
                    ownRateBps === c.rateBps
                      ? 'border-accent-600 bg-accent-50 font-medium text-accent-800 dark:border-accent-400 dark:bg-accent-500/15 dark:text-accent-200'
                      : 'border-border text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                  )}
                >
                  {t('vatCategoryOption', { name: c.name, rate: String(c.rateBps / 100) })}
                </button>
              ))}
              {vatText.trim() !== '' && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setVatText('');
                    touchPrice();
                  }}
                  className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t('vatRateClear')}
                </button>
              )}
            </div>
          )}
          <p
            id={`${titleId}-vatrate-hint`}
            className={cn('text-xs', vatInvalid ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}
          >
            {vatInvalid
              ? t('vatRateInvalid')
              : ownRateBps === 0
                ? t('vatRateZero')
                : ownRateBps !== null
                  ? t('vatRateSet', { rate: String(ownRateBps / 100) })
                  : fallbackCategory
                    ? t('vatRateFallback', { name: fallbackCategory.name, rate: String(fallbackCategory.rateBps / 100) })
                    : t('vatRateMissing')}
          </p>
        </fieldset>

        {/* ── The answer ─────────────────────────────────────────────────── */}
        <div className="rounded-xl bg-surface-2 px-4 py-3">
          {readout ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t('costLabel', { unit: pricedUnit })}
              </p>
              <p className="font-display text-2xl font-semibold tabular-nums">
                {formatMoney(readout.perPricedUnitExclVatCents, currency)}
              </p>
              {readout.perPricedUnitInclVatCents != null && taxRateBps != null && (
                // Naming the rate makes a wrong VAT visible — the same safety-net
                // principle as showing the cost per kg.
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t('costInclVatRate', {
                    amount: formatMoney(readout.perPricedUnitInclVatCents, currency),
                    rate: String(taxRateBps / 100),
                  })}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('costUnknown')}</p>
          )}
        </div>

        <div className="mt-1 flex items-center justify-between gap-2">
          {initialLink ? (
            <Button type="button" variant="ghost" onClick={onClear} disabled={pending}>
              {t('clear')}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t('cancel')}
            </Button>
            <Button type="button" onClick={onSave} disabled={pending || saveBlocked}>
              {t('save')}
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
