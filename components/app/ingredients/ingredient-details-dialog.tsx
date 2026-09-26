'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, X } from 'lucide-react';
import { ALLERGEN_CATALOG } from '@/lib/allergens/catalog';
import { NUTRIENT_KEYS } from '@/lib/calculations/nutrition';
import { suggestPurchaseVat } from '@/lib/calculations/supplierPriceForm';
import { formatMoney } from '@/lib/format/money';
import { displayPriceCents } from '@/lib/ingredients/incomplete';
import { nutritionViewStatus, type IngredientNutritionView } from '@/lib/nutrition/profile-view';
import { formatInUnit, PRICED_UNIT_LABEL, type Unit } from '@/lib/units';
import { PACK_UNITS } from '@/lib/validation/suppliers';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NUTRIENT_UNIT } from '@/components/app/ingredients/ingredient-nutrition-dialog';
import type { AllergenTag } from '@/lib/data/allergens';
import type { DefaultSupplierSummary } from '@/lib/data/ingredient-suppliers';
import {
  formatUpdated,
  type IngredientRow,
  type VatCategoryOption,
} from '@/components/app/ingredients/ingredient-grid';

type Section = 'supplier' | 'nutrition' | 'allergens' | 'notes';

const isPackUnit = (unit: string | null): unit is Unit =>
  unit !== null && (PACK_UNITS as readonly string[]).includes(unit);

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Read-only overview of ONE ingredient, opened from the row's View action so the
 * list keeps its search, sort and scroll position. Identity and price come first;
 * supplier, nutrition and allergens collapse. Viewing never writes: every edit
 * button hands off to the existing authorised editor (the parent swaps this popup
 * out while that editor is open, so popups are never stacked).
 *
 * Financial data (price, pack price, pending cost) is only rendered when the viewer
 * can see costs — and for kitchen the server never ships it in the first place.
 * Missing data reads "Not added" / "Not reviewed", never as zero or complete.
 */
export function IngredientDetailsDialog({
  open,
  row,
  canSeeCosts,
  currency,
  supplierLink,
  vatCategories,
  businessPurchaseVatBps,
  nutrition,
  allergens,
  allergensReviewed,
  canEditNutrition,
  onEditSupplier,
  onEditNutrition,
  onEditAllergens,
  onClose,
}: {
  open: boolean;
  row: IngredientRow;
  canSeeCosts: boolean;
  currency: string;
  /** Manager-only default supplier entry (pack, price, product name/code). */
  supplierLink: DefaultSupplierSummary | null;
  vatCategories: VatCategoryOption[];
  businessPurchaseVatBps: number | null;
  nutrition: IngredientNutritionView | null;
  allergens: AllergenTag[];
  allergensReviewed: boolean;
  canEditNutrition: boolean;
  onEditSupplier: () => void;
  onEditNutrition: () => void;
  onEditAllergens: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('ingredients.details');
  const tIngredients = useTranslations('ingredients');
  const tDim = useTranslations('dimensions');
  const tNutrition = useTranslations('ingredients.nutrition');
  const tNutrient = useTranslations('recipes.workspace.nutrition.nutrients');
  const tAllergens = useTranslations('allergens');
  const tAllergenNames = useTranslations('allergens.labels');
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const sectionId = React.useId();
  const [expanded, setExpanded] = React.useState<Record<Section, boolean>>({
    supplier: false,
    nutrition: false,
    allergens: false,
    notes: false,
  });

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  const toggle = (section: Section) =>
    setExpanded((prev) => ({ ...prev, [section]: !prev[section] }));

  const pricedUnit = PRICED_UNIT_LABEL[row.dimension];
  const notAdded = t('notAdded');

  // ── Price (manager only) ────────────────────────────────────────────────
  const vat = suggestPurchaseVat({
    entryBps: supplierLink?.vatRateBps ?? null,
    ingredientBps: row.vatRateBps ?? null,
    bandBps: vatCategories.find((c) => c.id === row.vatCategoryId)?.rateBps ?? null,
    businessBps: businessPurchaseVatBps,
  });
  const priceCents = displayPriceCents(row);

  // ── Supplier ────────────────────────────────────────────────────────────
  const supplierName = supplierLink?.supplierName ?? row.supplier ?? null;
  const packLabel =
    supplierLink && supplierLink.packSize !== null && isPackUnit(supplierLink.packUnit)
      ? supplierLink.unitsPerPack > 1
        ? t('supplier.packMulti', {
            units: supplierLink.unitsPerPack,
            size: formatInUnit(supplierLink.packSize, supplierLink.packUnit),
          })
        : formatInUnit(supplierLink.packSize, supplierLink.packUnit)
      : null;

  // ── Nutrition ───────────────────────────────────────────────────────────
  const nutritionStatus = nutritionViewStatus(nutrition);

  // ── Allergens ───────────────────────────────────────────────────────────
  const orderedAllergens = ALLERGEN_CATALOG.flatMap((entry) => {
    const tag = allergens.find((a) => a.allergen === entry.slug);
    return tag ? [tag] : [];
  });
  const allergenSummary = !allergensReviewed
    ? t('notReviewed')
    : orderedAllergens.length === 0
      ? t('allergens.noneRecorded')
      : t('allergens.count', { count: orderedAllergens.length });

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-0 text-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="flex flex-col gap-4 p-5">
        {/* Identity */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="break-words font-display text-lg font-semibold leading-snug">
              {row.name}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('measurement', { type: tDim(row.dimension), unit: tIngredients(`typePill.${row.dimension}`) })}
            </p>
            <p className="text-sm text-muted-foreground" suppressHydrationWarning>
              {t('updated', { date: formatUpdated(row.updatedAt) })}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('close')}
            title={t('close')}
            onClick={onClose}
            className="-mr-1 -mt-1 inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        {/* Price — never rendered (or shipped) for viewers who can't see costs */}
        {canSeeCosts ? (
          <section aria-labelledby={`${sectionId}-price`} className="flex flex-col gap-1 rounded-xl bg-surface-2 px-4 py-3">
            <h3 id={`${sectionId}-price`} className="text-sm font-medium text-muted-foreground">
              {t('price.title')}
            </h3>
            {priceCents === null ? (
              <p className="flex flex-wrap items-baseline gap-2 text-base">
                <span aria-hidden className="text-lg font-semibold">—</span>
                <span className="font-medium text-amber-800 dark:text-amber-300">{tIngredients('needsPricing')}</span>
              </p>
            ) : (
              <p className="flex flex-wrap items-baseline gap-1 tabular-nums">
                <span className="text-lg font-semibold">{formatMoney(priceCents, currency)}</span>
                <span className="text-base text-muted-foreground">{t('price.perUnit', { unit: pricedUnit })}</span>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {vat
                ? t('price.vatExclRate', { rate: String(vat.bps / 100) })
                : t('price.vatExclNoRate')}
            </p>
            {row.pendingPriceCents != null ? (
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                {t('price.pending', { amount: formatMoney(row.pendingPriceCents, currency), unit: pricedUnit })}
              </p>
            ) : null}
          </section>
        ) : null}

        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {/* Supplier */}
          <CollapsibleSection
            id={`${sectionId}-supplier`}
            title={t('supplier.title')}
            summary={supplierName ?? notAdded}
            open={expanded.supplier}
            onToggle={() => toggle('supplier')}
          >
            <dl className="flex flex-col gap-2">
              <Field label={t('supplier.name')} value={supplierName} empty={notAdded} />
              {canSeeCosts ? (
                <>
                  <Field label={t('supplier.productName')} value={supplierLink?.supplierProductName ?? null} empty={notAdded} />
                  <Field label={t('supplier.sku')} value={supplierLink?.supplierSku ?? null} empty={notAdded} />
                  <Field label={t('supplier.packSize')} value={packLabel} empty={notAdded} />
                  <Field
                    label={t('supplier.packPrice')}
                    value={
                      supplierLink?.packPriceCents != null
                        ? t('supplier.packPriceValue', { amount: formatMoney(supplierLink.packPriceCents, currency) })
                        : null
                    }
                    empty={notAdded}
                  />
                </>
              ) : null}
            </dl>
            {canSeeCosts ? (
              <Button type="button" variant="outline" className="w-fit" onClick={onEditSupplier}>
                {supplierLink ? t('supplier.edit') : t('supplier.add')}
              </Button>
            ) : null}
          </CollapsibleSection>

          {/* Nutrition */}
          <CollapsibleSection
            id={`${sectionId}-nutrition`}
            title={t('nutrition.title')}
            summary={tNutrition(`status.${nutritionStatus}`)}
            open={expanded.nutrition}
            onToggle={() => toggle('nutrition')}
          >
            {nutrition ? (
              <>
                <dl className="flex flex-col gap-2">
                  <Field
                    label={t('nutrition.source')}
                    value={[tNutrition(`current.source.${nutrition.source}`), nutrition.sourceDescription]
                      .filter(Boolean)
                      .join(' · ')}
                    empty={notAdded}
                  />
                  <Field
                    label={t('nutrition.reference')}
                    value={
                      nutrition.basisUnit === 'ml'
                        ? t('nutrition.per100ml', { grams: round(nutrition.basisGrams) })
                        : t('nutrition.perGrams', { grams: round(nutrition.basisGrams) })
                    }
                    empty={notAdded}
                  />
                </dl>
                <dl className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
                  {NUTRIENT_KEYS.map((key) => {
                    const value = nutrition.values[key];
                    return (
                      <div key={key} className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5">
                        <dt className="text-sm text-muted-foreground">{tNutrient(key)}</dt>
                        <dd className={cn('text-base tabular-nums', value === null && 'text-sm text-muted-foreground')}>
                          {value === null ? notAdded : `${round(value)} ${NUTRIENT_UNIT[key]}`}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </>
            ) : (
              <p className="text-base text-muted-foreground">{notAdded}</p>
            )}
            {canEditNutrition ? (
              <Button type="button" variant="outline" className="w-fit" onClick={onEditNutrition}>
                {nutrition ? t('nutrition.edit') : t('nutrition.add')}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">{tNutrition('readOnly')}</p>
            )}
          </CollapsibleSection>

          {/* Allergens */}
          <CollapsibleSection
            id={`${sectionId}-allergens`}
            title={t('allergens.title')}
            summary={allergenSummary}
            summaryTone={allergensReviewed ? 'default' : 'warning'}
            open={expanded.allergens}
            onToggle={() => toggle('allergens')}
          >
            <dl className="flex flex-col gap-2">
              <Field
                label={t('allergens.status')}
                value={allergensReviewed ? t('allergens.reviewed') : null}
                empty={t('notReviewed')}
              />
            </dl>
            {orderedAllergens.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border/60">
                {orderedAllergens.map((tag) => (
                  <li key={tag.allergen} className="flex items-baseline justify-between gap-3 py-1.5">
                    <span className="text-base">{tAllergenNames(tag.allergen)}</span>
                    <span className="text-sm text-muted-foreground">{tAllergens(`presence.${tag.presence}`)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-base text-muted-foreground">
                {allergensReviewed ? t('allergens.noneRecorded') : t('notReviewed')}
              </p>
            )}
            {!allergensReviewed && orderedAllergens.length > 0 ? (
              <p className="text-sm text-amber-800 dark:text-amber-300">{t('allergens.mayBeIncomplete')}</p>
            ) : null}
            <p className="text-sm text-muted-foreground">{t('allergens.disclaimer')}</p>
            <Button type="button" variant="outline" className="w-fit" onClick={onEditAllergens}>
              {allergensReviewed ? t('allergens.edit') : t('allergens.review')}
            </Button>
          </CollapsibleSection>

          {/* Notes — free text kept alongside supplier/pricing details, so it is
              only shown to viewers who can see costs (business-sensitive text,
              e.g. a supplier discount reminder). */}
          {canSeeCosts && (
            <CollapsibleSection
              id={`${sectionId}-notes`}
              title={t('notes.title')}
              summary={row.notes && row.notes.trim() !== '' ? t('notes.added') : notAdded}
              open={expanded.notes}
              onToggle={() => toggle('notes')}
            >
              {row.notes && row.notes.trim() !== '' ? (
                <p className="whitespace-pre-wrap break-words text-base">{row.notes}</p>
              ) : (
                <p className="text-base text-muted-foreground">{notAdded}</p>
              )}
            </CollapsibleSection>
          )}
        </div>
      </div>
    </dialog>
  );
}

function CollapsibleSection({
  id,
  title,
  summary,
  summaryTone = 'default',
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  summaryTone?: 'default' | 'warning';
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="flex min-h-12 w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronDown
            className={cn('size-5 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
            aria-hidden
          />
          <span className="text-base font-semibold">{title}</span>
          <span
            className={cn(
              'ml-auto min-w-0 truncate text-sm',
              summaryTone === 'warning' ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground',
            )}
          >
            {summary}
          </span>
        </button>
      </h3>
      <div id={id} hidden={!open} className={cn('flex flex-col gap-3 px-4 pb-4 pt-1', !open && 'hidden')}>
        {children}
      </div>
    </section>
  );
}

function Field({ label, value, empty }: { label: string; value: string | null; empty: string }) {
  const missing = value === null || value.trim() === '';
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={cn('break-words text-base sm:text-right', missing && 'text-sm text-muted-foreground')}>
        {missing ? empty : value}
      </dd>
    </div>
  );
}
