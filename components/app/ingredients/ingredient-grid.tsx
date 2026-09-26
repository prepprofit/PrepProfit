'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ChevronDown, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Ingredient } from '@/lib/db/schema';
import { DIMENSIONS } from '@/lib/validation/ingredients';
import { isLowStock } from '@/lib/calculations/inventory';
import { displayPriceCents } from '@/lib/ingredients/incomplete';
import {
  compareIngredients,
  DEFAULT_INGREDIENT_SORT,
  firstDirection,
  type IngredientSort,
  type IngredientSortColumn,
} from '@/lib/ingredients/sort';
import { ingredientMatchesQuery } from '@/lib/ingredients/search';
import { centsToAmountInput, formatMoney, parseMoneyToCents } from '@/lib/format/money';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { useActionError } from '@/lib/i18n/use-action-error';
import { useRowHighlight } from '@/lib/hooks/use-row-highlight';
import {
  deleteIngredientAction,
  updateIngredientAction,
} from '@/app/(app)/ingredients/actions';
import { IngredientAddDialog } from '@/components/app/ingredients/ingredient-add-dialog';
import { IngredientAllergenDialog } from '@/components/app/ingredients/ingredient-allergen-dialog';
import { IngredientCatalogDialog } from '@/components/app/ingredients/ingredient-catalog-dialog';
import {
  IngredientSupplierDialog,
  type IngredientEditorSavedUpdate,
} from '@/components/app/ingredients/ingredient-supplier-dialog';
import { IngredientNutritionDialog } from '@/components/app/ingredients/ingredient-nutrition-dialog';
import { IngredientDetailsDialog } from '@/components/app/ingredients/ingredient-details-dialog';
import type { IngredientNutritionView } from '@/lib/nutrition/profile-view';
import { AddToTaskListMenu } from '@/components/app/tasks/add-to-task-list-menu';
import type { AllergenTag } from '@/lib/data/allergens';
import type { SupplierPriceBasis } from '@/lib/calculations/purchasePrice';
import type { DefaultSupplierSummary } from '@/lib/data/ingredient-suppliers';
import type { IngredientTypeLock, IngredientUsage } from '@/lib/data/ingredients';
import { restoreIngredientAction } from '@/app/(app)/trash/actions';

type Dimension = Ingredient['dimension'];

/**
 * Row shape the grid renders. Price is OPTIONAL: for kitchen the server ships rows
 * with no `priceCents` key at all (Sprint F4), and the Price column is not rendered.
 */
export type IngredientRow = Omit<Ingredient, 'priceCents' | 'pendingPriceCents' | 'notes'> & {
  priceCents?: number;
  pendingPriceCents?: number | null;
  /** Manager-only free-text notes; absent for a kitchen row (Sprint F4). */
  notes?: string | null;
};

/**
 * How one supplier quotes prices, remembered from the last pack saved against them,
 * so the supplier dialog's two selects prefill instead of being re-picked per
 * ingredient. NULL on either field = never set → the dialog falls back to whole-pack
 * / excl. VAT.
 */
export type SupplierPricePrefs = {
  basis: SupplierPriceBasis | null;
  includesVat: boolean | null;
};

/**
 * One purchase VAT band the supplier dialog can apply. Purchase VAT depends on the
 * GOODS (food vs alcohol vs non-food), not on the business, so the rate rides on
 * the ingredient's band rather than on a single org-wide setting.
 */
export type VatCategoryOption = {
  id: string;
  name: string;
  rateBps: number;
  isDefault: boolean;
};

type Draft = {
  name: string;
  dimension: Dimension;
  priceText: string;
};

/** The price reference unit per dimension (prices are stored per kg / litre / piece). */
const PER_UNIT_SUFFIX: Record<Dimension, string> = {
  weight: '/kg',
  volume: '/l',
  count: '/pc',
};

function draftFromRow(row: IngredientRow): Draft {
  return {
    name: row.name,
    dimension: row.dimension,
    // An unpriced ingredient opens with an empty price, never a pre-filled "0.00".
    priceText:
      row.priceCents != null && !row.needsPricing ? centsToAmountInput(row.priceCents) : '',
  };
}

/** Operational fields only — what a kitchen edit sends (no price, no supplier). */
function operationalInput(draft: Draft) {
  return {
    name: draft.name.trim(),
    dimension: draft.dimension,
  };
}

/**
 * The system-set "last touched" stamp. Rendered with `suppressHydrationWarning`
 * because the server formats in UTC and the browser in the viewer's zone, which can
 * disagree by a day at the boundary — a cosmetic diff, never a data one.
 */
export function formatUpdated(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Everything a row needs to render itself, shared across the whole list. */
type RowContext = {
  drafts: Record<string, Draft>;
  currency: string;
  canSeeCosts: boolean;
  canManageSuppliers: boolean;
  pending: boolean;
  editingId: string | null;
  onField: (id: string, patch: Partial<Draft>) => void;
  onEdit: (id: string) => void;
  onSave: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onView: (id: string) => void;
  onEditSupplier: (id: string) => void;
  /**
   * Manager-only (Sprint 6 D7): true when a "reorder from ingredient" task may be
   * offered for this row — i.e. the viewer sees costs AND the row is at/below its
   * low-stock threshold. The reorder task itself is money-free.
   */
  canReorder: (id: string) => boolean;
  dimensionLabel: (d: Dimension) => string;
  dimensionPillLabel: (d: Dimension) => string;
  /** Why this row's type can't change (null = it can). */
  typeLockReason: (id: string) => string | null;
  supplierName: (id: string) => string | null;
  t: ReturnType<typeof useTranslations>;
  tSuppliers: ReturnType<typeof useTranslations>;
};

export function IngredientGrid({
  initialIngredients,
  canSeeCosts,
  currency,
  highlightId,
  initialAllergens,
  initialReviewed,
  supplierNames = [],
  initialSupplierLinks = {},
  supplierPricePrefs = {},
  vatCategories = [],
  businessPurchaseVatBps = null,
  mostCommonPurchaseVatBps = null,
  typeLocks = {},
  initialNutrition = {},
  canEditNutrition = false,
}: {
  initialIngredients: IngredientRow[];
  /** Manager only: render + edit the Price column. Kitchen rows carry no price. */
  canSeeCosts: boolean;
  currency: string;
  /** Record id to scroll to + flash, from a ⌘K search deep-link (?highlight=). */
  highlightId?: string;
  /** Allergen tags per ingredient id (Sprint 9) — operational, money-free. */
  initialAllergens: Record<string, AllergenTag[]>;
  /** Which ingredient ids have had their allergens reviewed (reviewed_at set). */
  initialReviewed: Record<string, boolean>;
  /** Active supplier names for the picker datalist (manager-only, Sprint 7). */
  supplierNames?: string[];
  /** Default supplier link per ingredient id, to prefill the editor (manager-only). */
  initialSupplierLinks?: Record<string, DefaultSupplierSummary>;
  /** Remembered price-entry preferences per supplier NAME (manager-only). */
  supplierPricePrefs?: Record<string, SupplierPricePrefs>;
  /** The org's purchase VAT bands — shortcuts in the supplier dialog (manager-only). */
  vatCategories?: VatCategoryOption[];
  /** The business's configured default purchase VAT (bps) — supplier editor default. */
  businessPurchaseVatBps?: number | null;
  /** Last-resort VAT prefill: the business's most common confirmed purchase rate. */
  mostCommonPurchaseVatBps?: number | null;
  /** Ingredients whose type is locked because quantities use the current unit. */
  typeLocks?: Record<string, IngredientTypeLock>;
  /** Each ingredient's own nutrition profile (absent = not added). */
  initialNutrition?: Record<string, IngredientNutritionView>;
  /** Manager-only editing; kitchen opens the nutrition view read-only. */
  canEditNutrition?: boolean;
}) {
  const t = useTranslations('ingredients');
  const flashId = useRowHighlight(highlightId, 'ingredient-row-');
  const tDim = useTranslations('dimensions');
  const tCommon = useTranslations('common');
  const tSuppliers = useTranslations('suppliers.ingredientEditor');
  const actionError = useActionError();
  const [rows, setRows] = React.useState<IngredientRow[]>(initialIngredients);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>(() =>
    Object.fromEntries(initialIngredients.map((r) => [r.id, draftFromRow(r)])),
  );
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<IngredientSort>(DEFAULT_INGREDIENT_SORT);
  // Suppliers (Sprint 7, manager-only): the default link per ingredient + which
  // row's supplier editor is open. Declared before `visibleRows` — search reads it.
  const [supplierLinks, setSupplierLinks] = React.useState<
    Record<string, DefaultSupplierSummary | null>
  >(() => ({ ...initialSupplierLinks }));
  /**
   * Search + sort over the COMPLETE loaded list (there is no pagination — the page
   * loads every active ingredient up front), driven by the compact "Sort by"
   * control. Rows whose COST can't be trusted stay pinned on top at the DEFAULT sort
   * (decision D2) — see `compareIngredients`; picking a column clears that pin.
   */
  const visibleRows = React.useMemo(() => {
    return rows
      .filter((r) => ingredientMatchesQuery(r, supplierLinks[r.id] ?? null, query))
      .sort((a, b) => compareIngredients(a, b, sort, canSeeCosts));
  }, [rows, query, sort, canSeeCosts, supplierLinks]);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [deleteProblem, setDeleteProblem] = React.useState<
    { kind: 'in_use'; usage: IngredientUsage } | { kind: 'error'; message: string } | null
  >(null);
  const [notice, setNotice] = React.useState<{ message: string; undo: IngredientRow | null; isError?: boolean } | null>(null);
  // Explicit edit: exactly one row is editable at a time and NOTHING commits until
  // Save. (Replaces the old auto-save-on-blur, which wrote silently on every focus
  // change and forced every cell to look like an input.)
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  // Allergens (Sprint 9): tags + reviewed state per ingredient, plus which row's
  // allergen editor is open. Editing an allergen set marks the ingredient reviewed.
  const [allergens, setAllergens] =
    React.useState<Record<string, AllergenTag[]>>(initialAllergens);
  const [reviewed, setReviewed] =
    React.useState<Record<string, boolean>>(initialReviewed);
  const [allergenEditId, setAllergenEditId] = React.useState<string | null>(null);
  const [nutrition, setNutrition] =
    React.useState<Record<string, IngredientNutritionView>>(initialNutrition);
  const [nutritionEditId, setNutritionEditId] = React.useState<string | null>(null);
  // The details popup. Its editors (supplier / nutrition / allergens) REPLACE it while
  // open and hand back to it on close, so popups never stack.
  const [detailsId, setDetailsId] = React.useState<string | null>(null);
  const [supplierEditId, setSupplierEditId] = React.useState<string | null>(null);
  // Which entry point opened the unified editor (pencil vs. the supplier shortcut)
  // — steers initial focus only; both open the exact same dialog.
  const [editorFocus, setEditorFocus] = React.useState<'name' | 'supplier'>('name');
  // Price-entry preferences per supplier name, updated in place as packs are saved
  // so a second ingredient from the same supplier prefills without a round-trip.
  const [pricePrefs, setPricePrefs] = React.useState<
    Record<string, SupplierPricePrefs>
  >(() => ({ ...supplierPricePrefs }));
  // Seed catalogue picker (docs/ingredient-seed-catalog-plan.md Slice 4).
  const [catalogOpen, setCatalogOpen] = React.useState(false);
  // Manual add popup — occasional work, so it stays one click away instead of
  // sitting on the page as an always-on form.
  const [addOpen, setAddOpen] = React.useState(false);

  const confirmTarget = rows.find((r) => r.id === confirmId) ?? null;
  const allergenTarget = rows.find((r) => r.id === allergenEditId) ?? null;
  const supplierTarget = rows.find((r) => r.id === supplierEditId) ?? null;
  const nutritionTarget = rows.find((r) => r.id === nutritionEditId) ?? null;
  const detailsTarget = rows.find((r) => r.id === detailsId) ?? null;
  const editorOpen =
    allergenEditId !== null || nutritionEditId !== null || supplierEditId !== null;

  const dimensionLabel = React.useCallback((d: Dimension) => tDim(d), [tDim]);
  const dimensionPillLabel = React.useCallback(
    (d: Dimension) => t(`typePill.${d}`),
    [t],
  );
  const typeLockReason = React.useCallback(
    (id: string) => {
      const lock = typeLocks[id];
      if (!lock) return null;
      const parts = [
        lock.recipes > 0 ? t('typeLock.recipes', { count: lock.recipes }) : null,
        lock.menus > 0 ? t('typeLock.menus', { count: lock.menus }) : null,
        lock.stock ? t('typeLock.stock') : null,
      ].filter((p): p is string => p !== null);
      return t('typeLock.reason', { uses: parts.join(', ') });
    },
    [typeLocks, t],
  );

  const onField = React.useCallback((id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: { ...current, ...patch } };
    });
  }, []);

  /** Reset a row's working copy back to what is actually stored. */
  const resetDraft = React.useCallback(
    (id: string) =>
      setDrafts((prev) => {
        const row = rows.find((r) => r.id === id);
        return row ? { ...prev, [id]: draftFromRow(row) } : prev;
      }),
    [rows],
  );

  const onEdit = React.useCallback(
    (id: string) => {
      setError(null);
      // Manager: the pencil opens the unified editor (name + supplier + pricing +
      // measurement type, one Save). Kitchen: operational-only inline row editor
      // (name + dimension), unchanged.
      if (canSeeCosts) {
        setEditorFocus('name');
        setSupplierEditId(id);
        return;
      }
      // Switching rows discards the previous row's uncommitted edits — nothing was
      // ever sent, so the only state to clear is the local draft.
      setEditingId((prev) => {
        if (prev && prev !== id) resetDraft(prev);
        return id;
      });
      resetDraft(id);
    },
    [resetDraft, canSeeCosts],
  );

  const onCancel = React.useCallback(
    (id: string) => {
      resetDraft(id);
      setError(null);
      setEditingId((prev) => (prev === id ? null : prev));
    },
    [resetDraft],
  );

  const onSave = React.useCallback(
    (id: string) => {
      const draft = drafts[id];
      const row = rows.find((r) => r.id === id);
      if (!draft || !row) return;
      // Kitchen sends operational fields only (never a price); manager includes it.
      const op = operationalInput(draft);
      const priceCents = parseMoneyToCents(draft.priceText);
      const input = canSeeCosts ? { ...op, priceCents } : op;
      if (op.name === '') {
        // Stay in edit mode: a blank name is a mistake to fix, not a value to store.
        setError(t('errors.nameRequired'));
        return;
      }
      // Skip the round-trip when nothing actually changed. (Supplier is edited
      // through the supplier dialog, not this inline row — Sprint 7.)
      const unchanged =
        op.name === row.name &&
        op.dimension === row.dimension &&
        (!canSeeCosts || priceCents === (row.priceCents ?? 0));
      if (unchanged) {
        resetDraft(id);
        setError(null);
        setEditingId(null);
        return;
      }
      setError(null);
      startTransition(async () => {
        const result = await updateIngredientAction(id, input);
        if (result.ok) {
          setRows((prev) => prev.map((r) => (r.id === id ? result.data : r)));
          setDrafts((prev) => ({ ...prev, [id]: draftFromRow(result.data) }));
          setEditingId(null);
        } else {
          // Keep the row open with the typed values so the fix is one edit away.
          setError(actionError(result.code));
        }
      });
    },
    [drafts, rows, resetDraft, actionError, canSeeCosts, t],
  );

  const requestDelete = React.useCallback((id: string) => {
    setDeleteProblem(null);
    setConfirmId(id);
  }, []);
  const editSupplier = React.useCallback((id: string) => {
    setEditorFocus('supplier');
    setSupplierEditId(id);
  }, []);
  const viewDetails = React.useCallback((id: string) => setDetailsId(id), []);
  const closeDetails = React.useCallback(() => {
    const id = detailsId;
    setDetailsId(null);
    // Hand focus back to the row's View button without moving the list: search,
    // sort and scroll position all live in this component and are untouched.
    if (id) {
      window.requestAnimationFrame(() =>
        document.getElementById(`ingredient-view-${id}`)?.focus({ preventScroll: true }),
      );
    }
  }, [detailsId]);
  const supplierName = React.useCallback(
    (id: string) => rows.find((r) => r.id === id)?.supplier ?? null,
    [rows],
  );
  const canReorder = React.useCallback(
    (id: string) => {
      // Reorder is manager-only (the action returns FORBIDDEN otherwise), so we
      // never render a dead button for kitchen. Scope it to genuinely low-stock
      // rows — the semantics of a reorder task.
      if (!canSeeCosts) return false;
      const row = rows.find((r) => r.id === id);
      if (!row) return false;
      return isLowStock(
        Number(row.stockQuantity),
        row.lowStockThreshold != null ? Number(row.lowStockThreshold) : null,
      );
    },
    [rows, canSeeCosts],
  );

  const confirmDelete = React.useCallback(() => {
    const id = confirmId;
    if (!id) return;
    const row = rows.find((r) => r.id === id);
    setError(null);
    setDeleteProblem(null);
    startTransition(async () => {
      const result = await deleteIngredientAction(id);
      if (!result.ok) {
        // Keep the dialog open and say why, right where the user is looking.
        setDeleteProblem({ kind: 'error', message: actionError(result.code) });
        return;
      }
      if (result.data.status === 'in_use') {
        setDeleteProblem({ kind: 'in_use', usage: result.data.usage });
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setEditingId((prev) => (prev === id ? null : prev));
      setDetailsId((prev) => (prev === id ? null : prev));
      setConfirmId(null);
      setNotice({ message: t('deleted', { name: row?.name ?? '' }), undo: row ?? null });
    });
  }, [confirmId, actionError, rows, t]);

  const undoDelete = React.useCallback(
    (row: IngredientRow) => {
      startTransition(async () => {
        const result = await restoreIngredientAction(row.id);
        if (!result.ok) {
          setNotice({ message: actionError(result.code), undo: null, isError: true });
          return;
        }
        setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]));
        setDrafts((prev) => ({ ...prev, [row.id]: draftFromRow(row) }));
        setNotice({ message: t('restored', { name: row.name }), undo: null });
      });
    },
    [actionError, t],
  );

  // The confirmation toast clears itself after a few seconds.
  React.useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.undo ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /** Adopt a row created elsewhere (add popup, catalogue) into the loaded list. */
  const adoptRow = React.useCallback((row: IngredientRow) => {
    setRows((prev) => [...prev, row]);
    setDrafts((prev) => ({ ...prev, [row.id]: draftFromRow(row) }));
  }, []);

  const ctx: RowContext = {
    drafts,
    currency,
    canSeeCosts,
    canManageSuppliers: canSeeCosts,
    pending,
    editingId,
    onField,
    onEdit,
    onSave,
    onCancel,
    onDelete: requestDelete,
    onView: viewDetails,
    onEditSupplier: editSupplier,
    canReorder,
    dimensionLabel,
    dimensionPillLabel,
    typeLockReason,
    supplierName,
    t,
    tSuppliers,
  };

  const isDateSort = sort.column === 'updated';
  const directionLabel = isDateSort
    ? t(sort.direction === 'asc' ? 'sort.direction.dateAsc' : 'sort.direction.dateDesc')
    : t(sort.direction === 'asc' ? 'sort.direction.alphaAsc' : 'sort.direction.alphaDesc');

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/*
        Search-first: the page's frequent tasks are search / browse / select, so the
        search field owns the row. The compact "Sort by" control and the two add
        paths sit beside it — sorting is occasional, adding is occasional, neither
        should crowd the everyday search.
      */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          type="search"
          aria-label={t('searchPlaceholder')}
          placeholder={t('searchPlaceholder')}
          className="sm:flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <div className="flex items-center gap-1.5">
            <Select
              aria-label={t('sort.label')}
              className="w-auto min-w-[9.5rem] text-sm"
              value={sort.column}
              onChange={(e) => {
                const column = e.target.value as IngredientSortColumn;
                setSort({ column, direction: firstDirection(column) });
              }}
            >
              <option value="name">{t('sort.column.name')}</option>
              <option value="supplier">{t('sort.column.supplier')}</option>
              <option value="updated">{t('sort.column.updated')}</option>
            </Select>
            <button
              type="button"
              onClick={() =>
                setSort((current) => ({
                  column: current.column,
                  direction: current.direction === 'asc' ? 'desc' : 'asc',
                }))
              }
              aria-label={directionLabel}
              title={directionLabel}
              className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {sort.direction === 'asc' ? (
                <ArrowUp className="size-4" aria-hidden />
              ) : (
                <ArrowDown className="size-4" aria-hidden />
              )}
            </button>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setCatalogOpen(true)}
          >
            {t('catalog.open')}
          </Button>
          {/* The ONE primary (mint) action on this screen. */}
          <Button type="button" disabled={pending} onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {t('actions.addIngredient')}
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden">
        {visibleRows.length === 0 ? (
          <div className="px-4 py-8 text-center text-base text-muted-foreground">
            {query ? t('noMatches') : t('empty')}
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {visibleRows.map((row) => (
              <IngredientRowItem
                key={row.id}
                row={row}
                flash={flashId === row.id}
                ctx={ctx}
              />
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmId !== null}
        title={deleteProblem?.kind === 'in_use' ? t('deleteBlocked.title') : t('deleteConfirm.title')}
        description={
          deleteProblem?.kind === 'in_use'
            ? t('deleteBlocked.body', { name: confirmTarget?.name ?? '' })
            : t('deleteConfirm.body', { name: confirmTarget?.name ?? '' })
        }
        confirmLabel={deleteProblem?.kind === 'in_use' ? t('deleteBlocked.tryAgain') : tCommon('moveToTrash')}
        cancelLabel={deleteProblem?.kind === 'in_use' ? t('deleteBlocked.close') : tCommon('cancel')}
        destructive={deleteProblem?.kind !== 'in_use'}
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => {
          setConfirmId(null);
          setDeleteProblem(null);
        }}
      >
        {deleteProblem?.kind === 'in_use' ? (
          <div role="alert" className="mt-2 flex flex-col gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">
            {deleteProblem.usage.recipeCount > 0 && (
              <p>
                {t('deleteBlocked.recipes', { count: deleteProblem.usage.recipeCount })}{' '}
                <span className="font-medium">
                  {deleteProblem.usage.recipeNames.join(', ')}
                  {deleteProblem.usage.recipeCount > deleteProblem.usage.recipeNames.length ? '…' : ''}
                </span>
              </p>
            )}
            {deleteProblem.usage.menuCount > 0 && (
              <p>
                {t('deleteBlocked.menus', { count: deleteProblem.usage.menuCount })}{' '}
                <span className="font-medium">
                  {deleteProblem.usage.menuNames.join(', ')}
                  {deleteProblem.usage.menuCount > deleteProblem.usage.menuNames.length ? '…' : ''}
                </span>
              </p>
            )}
            <p className="text-xs">{t('deleteBlocked.help')}</p>
          </div>
        ) : deleteProblem?.kind === 'error' ? (
          <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
            {deleteProblem.message}
          </p>
        ) : null}
      </ConfirmDialog>

      {notice && (
        <div
          role={notice.isError ? 'alert' : 'status'}
          className={cn(
            'fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-lg',
            notice.isError
              ? 'bg-red-700 text-white'
              : 'bg-foreground text-background',
          )}
        >
          <span>{notice.message}</span>
          {notice.undo && canSeeCosts && (
            <button
              type="button"
              disabled={pending}
              onClick={() => notice.undo && undoDelete(notice.undo)}
              className="cursor-pointer font-semibold underline underline-offset-2"
            >
              {t('undo')}
            </button>
          )}
          <button type="button" aria-label={tCommon('close')} onClick={() => setNotice(null)} className="cursor-pointer opacity-70 hover:opacity-100">
            ×
          </button>
        </div>
      )}

      <IngredientAddDialog
        open={addOpen}
        canSeeCosts={canSeeCosts}
        onClose={() => setAddOpen(false)}
        onCreated={(ingredient) => {
          // Kitchen rows carry no price keys (Sprint F4) — IngredientRow allows that.
          const row = ingredient as IngredientRow;
          adoptRow(row);
          setAllergens((prev) => ({ ...prev, [row.id]: [] }));
          setReviewed((prev) => ({ ...prev, [row.id]: false }));
        }}
        onBrowseCatalog={() => {
          setAddOpen(false);
          setCatalogOpen(true);
        }}
      />

      <IngredientCatalogDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onCreated={(ingredient, tags) => {
          // Kitchen rows carry no price keys (Sprint F4) — IngredientRow allows that.
          const row = ingredient as IngredientRow;
          adoptRow(row);
          setAllergens((prev) => ({ ...prev, [row.id]: tags }));
          // Seeded allergens are typical + UNREVIEWED until a human reviews them.
          setReviewed((prev) => ({ ...prev, [row.id]: false }));
        }}
      />

      {detailsTarget && (
        <IngredientDetailsDialog
          key={detailsTarget.id}
          open={!editorOpen}
          row={detailsTarget}
          canSeeCosts={canSeeCosts}
          currency={currency}
          supplierLink={canSeeCosts ? (supplierLinks[detailsTarget.id] ?? null) : null}
          vatCategories={vatCategories}
          businessPurchaseVatBps={businessPurchaseVatBps}
          nutrition={nutrition[detailsTarget.id] ?? null}
          allergens={allergens[detailsTarget.id] ?? []}
          allergensReviewed={reviewed[detailsTarget.id] === true}
          canEditNutrition={canEditNutrition}
          onEditSupplier={() => editSupplier(detailsTarget.id)}
          onEditNutrition={() => setNutritionEditId(detailsTarget.id)}
          onEditAllergens={() => setAllergenEditId(detailsTarget.id)}
          onClose={closeDetails}
        />
      )}

      {allergenTarget && (
        <IngredientAllergenDialog
          open={allergenEditId !== null}
          ingredientId={allergenTarget.id}
          ingredientName={allergenTarget.name}
          initialTags={allergens[allergenTarget.id] ?? []}
          onClose={() => setAllergenEditId(null)}
          onSaved={(tags) => {
            const id = allergenTarget.id;
            setAllergens((prev) => ({ ...prev, [id]: tags }));
            // Saving (even an empty set) marks the ingredient reviewed.
            setReviewed((prev) => ({ ...prev, [id]: true }));
          }}
        />
      )}

      {nutritionTarget && (
        <IngredientNutritionDialog
          key={nutritionTarget.id}
          ingredientId={nutritionTarget.id}
          ingredientName={nutritionTarget.name}
          suggestedFdcId={nutritionTarget.suggestedFdcId ?? null}
          profile={nutrition[nutritionTarget.id] ?? null}
          canEdit={canEditNutrition}
          onChange={(view) => {
            const id = nutritionTarget.id;
            setNutrition((prev) => {
              const next = { ...prev };
              if (view) next[id] = view;
              else delete next[id];
              return next;
            });
          }}
          onClose={() => setNutritionEditId(null)}
        />
      )}

      {canSeeCosts && supplierTarget && (
        <IngredientSupplierDialog
          open={supplierEditId !== null}
          ingredientId={supplierTarget.id}
          ingredientName={supplierTarget.name}
          dimension={supplierTarget.dimension}
          currency={currency}
          vatCategories={vatCategories}
          vatCategoryId={supplierTarget.vatCategoryId ?? null}
          vatRateBps={supplierTarget.vatRateBps ?? null}
          businessPurchaseVatBps={businessPurchaseVatBps}
          mostCommonPurchaseVatBps={mostCommonPurchaseVatBps}
          currentPriceCents={supplierTarget.priceCents ?? null}
          supplierNames={supplierNames}
          pricePrefs={pricePrefs}
          initialLink={supplierLinks[supplierTarget.id] ?? null}
          pendingPriceCents={supplierTarget.pendingPriceCents ?? null}
          notes={supplierTarget.notes ?? null}
          focusSection={editorFocus}
          onClose={() => setSupplierEditId(null)}
          onSaved={(update: IngredientEditorSavedUpdate) => {
            const id = supplierTarget.id;
            const merged = { ...supplierTarget, ...update.ingredient } as IngredientRow;
            setRows((prev) => prev.map((r) => (r.id === id ? merged : r)));
            setDrafts((prev) => ({ ...prev, [id]: draftFromRow(merged) }));
            const { supplierChange, prefs } = update;
            if (supplierChange.type === 'set') {
              setSupplierLinks((prev) => ({ ...prev, [id]: supplierChange.link }));
              if (prefs) setPricePrefs((prev) => ({ ...prev, [supplierChange.link.supplierName]: prefs }));
            } else if (supplierChange.type === 'cleared') {
              setSupplierLinks((prev) => ({ ...prev, [id]: null }));
            }
            if (update.notice && !update.notice.incomplete) {
              setNotice({ message: update.notice.message, undo: null });
            }
          }}
          onAccepted={(priceCents) => {
            const id = supplierTarget.id;
            setRows((prev) =>
              prev.map((r) =>
                r.id === id
                  ? {
                      ...r,
                      priceCents,
                      pendingPriceCents: null,
                      // Mirrors the server: an accepted real cost clears "needs pricing".
                      needsPricing: priceCents > 0 ? false : r.needsPricing,
                    }
                  : r,
              ),
            );
            setDrafts((prev) => {
              const row = rows.find((r) => r.id === id);
              return row
                ? {
                    ...prev,
                    [id]: draftFromRow({
                      ...row,
                      priceCents,
                      needsPricing: priceCents > 0 ? false : row.needsPricing,
                    }),
                  }
                : prev;
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * One ingredient row: name + supplier grouped on the left (the name takes most of
 * the width and wraps freely), price + row actions grouped on the right. The same
 * two-zone layout holds at every width — only the name's wrapping and the right
 * zone's own wrapping (price above icons, if it ever gets tight) respond to space.
 */
function IngredientRowItem({
  row,
  flash,
  ctx,
}: {
  row: IngredientRow;
  flash: boolean;
  ctx: RowContext;
}) {
  const { t, tSuppliers } = ctx;
  const draft = ctx.drafts[row.id];
  if (!draft) return null;
  const editing = ctx.editingId === row.id;
  const lockReason = ctx.typeLockReason(row.id);
  const supplier = ctx.supplierName(row.id);
  const noSupplierLabel = tSuppliers('none');
  const hasPending = ctx.canManageSuppliers && row.pendingPriceCents != null;
  const priceCents = ctx.canSeeCosts ? displayPriceCents(row) : null;

  return (
    <div
      id={`ingredient-row-${row.id}`}
      // Enter saves, Esc cancels — the keyboard mirror of the Save/Cancel buttons.
      onKeyDown={
        editing
          ? (e) => {
              if (e.key === 'Enter') {
                // A focused button (Save/Cancel/supplier) already acts on Enter;
                // saving again here would double-fire.
                if (e.target instanceof HTMLElement && e.target.closest('button')) return;
                e.preventDefault();
                ctx.onSave(row.id);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                ctx.onCancel(row.id);
              }
            }
          : undefined
      }
      className={cn(
        'flex items-start justify-between gap-3 px-4 py-3 transition-colors duration-700',
        editing && 'bg-accent-500/5',
        flash && 'bg-accent-500/10',
      )}
    >
      {/* Left: identity — name, then supplier (or the type editor while editing). */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {editing ? (
          <Input
            autoFocus
            aria-label={t('columns.name')}
            value={draft.name}
            disabled={ctx.pending}
            onChange={(e) => ctx.onField(row.id, { name: e.target.value })}
          />
        ) : (
          <span className="break-words text-lg font-semibold leading-snug text-foreground">
            {row.name}
          </span>
        )}

        {editing ? (
          <div className="flex flex-col gap-1">
            <Select
              aria-label={t('columns.dimension')}
              aria-describedby={lockReason ? `type-lock-${row.id}` : undefined}
              className="w-40"
              value={draft.dimension}
              disabled={ctx.pending || lockReason !== null}
              onChange={(e) =>
                ctx.onField(row.id, { dimension: e.target.value as Dimension })
              }
            >
              {DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {ctx.dimensionLabel(d)} ({ctx.dimensionPillLabel(d)})
                </option>
              ))}
            </Select>
            {lockReason ? (
              <span id={`type-lock-${row.id}`} className="text-sm leading-snug text-muted-foreground">
                {lockReason}
              </span>
            ) : draft.dimension !== row.dimension && ctx.canSeeCosts ? (
              <span className="text-sm leading-snug text-amber-800 dark:text-amber-300">
                {t('typeLock.checkPrice', { unit: ctx.dimensionPillLabel(draft.dimension) })}
              </span>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {ctx.canManageSuppliers ? (
                <button
                  type="button"
                  disabled={ctx.pending}
                  title={`${t('columns.supplier')}: ${supplier ?? noSupplierLabel}`}
                  aria-haspopup="dialog"
                  onClick={() => ctx.onEditSupplier(row.id)}
                  // Compact text + caret; the invisible ::after pad keeps a comfortable target.
                  className={cn(
                    'relative inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded text-[13px] after:absolute after:-inset-x-1.5 after:-inset-y-2.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
                    supplier ? 'text-foreground/80' : 'text-muted-foreground',
                  )}
                >
                  <span className="truncate">{supplier ?? noSupplierLabel}</span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              ) : (
                supplier && (
                  <span className="truncate text-[13px] text-muted-foreground">{supplier}</span>
                )
              )}
              {hasPending && (
                <span className="whitespace-nowrap text-xs font-medium text-amber-800 dark:text-amber-300">
                  {tSuppliers('pendingBadge')}
                </span>
              )}
            </div>
            {row.needsPricing && !ctx.canSeeCosts && (
              <span className="text-xs text-muted-foreground">{t('needsPricing')}</span>
            )}
          </>
        )}
      </div>

      {/* Right: price, then the row's actions — Save/Cancel while editing. */}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {editing ? (
          <>
            {ctx.canSeeCosts && (
              <div className="flex items-center gap-1.5">
                <Input
                  aria-label={t('columns.price')}
                  inputMode="decimal"
                  className="w-24 text-right tabular-nums"
                  value={draft.priceText}
                  disabled={ctx.pending}
                  onChange={(e) => ctx.onField(row.id, { priceText: e.target.value })}
                />
                <span className="text-xs text-muted-foreground">
                  {PER_UNIT_SUFFIX[draft.dimension]}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={ctx.pending}
                onClick={() => ctx.onCancel(row.id)}
                className="text-base"
              >
                {t('actions.cancel')}
              </Button>
              <Button
                type="button"
                disabled={ctx.pending}
                onClick={() => ctx.onSave(row.id)}
                className="text-base"
              >
                {t('actions.save')}
              </Button>
            </div>
          </>
        ) : (
          <>
            {ctx.canSeeCosts &&
              (priceCents === null ? (
                // Unpriced reads "—" plus one small, neutral action — never a red flag
                // repeated on the row; the "why" lives in the editor/details.
                <div className="flex items-baseline gap-1.5 whitespace-nowrap">
                  <span aria-hidden className="text-base text-muted-foreground">—</span>
                  <button
                    type="button"
                    disabled={ctx.pending}
                    onClick={() => ctx.onEdit(row.id)}
                    className="cursor-pointer text-xs font-medium text-accent-700 hover:underline disabled:cursor-default disabled:no-underline dark:text-accent-300"
                  >
                    {t('actions.addPrice')}
                  </button>
                </div>
              ) : (
                <div className="flex items-baseline gap-1 whitespace-nowrap tabular-nums">
                  <span className="text-base font-normal text-foreground">
                    {formatMoney(priceCents, ctx.currency)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {PER_UNIT_SUFFIX[row.dimension]}
                  </span>
                </div>
              ))}
            <div className="-my-1 -mr-1.5 flex items-center">
              {ctx.canReorder(row.id) && <AddToTaskListMenu kind="reorder" sourceId={row.id} />}
              <IconAction
                id={`ingredient-view-${row.id}`}
                label={t('actions.view')}
                disabled={ctx.pending}
                onClick={() => ctx.onView(row.id)}
              >
                <Eye />
              </IconAction>
              <IconAction
                label={t('actions.edit')}
                disabled={ctx.pending}
                onClick={() => ctx.onEdit(row.id)}
              >
                <Pencil />
              </IconAction>
              <IconAction
                label={t('actions.delete')}
                disabled={ctx.pending}
                onClick={() => ctx.onDelete(row.id)}
              >
                <Trash2 />
              </IconAction>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A row icon action: accessible name, a visible tooltip on hover AND keyboard focus
 * (a bare `title` never shows on focus), and a 40 px click target.
 */
function IconAction({
  id,
  label,
  disabled,
  onClick,
  children,
}: {
  id?: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <span className="group relative inline-flex">
      <Button
        id={id}
        type="button"
        variant="ghost"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="size-9 p-0 hover:bg-transparent hover:text-foreground [&_svg]:size-4"
      >
        {children}
      </Button>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-full right-0 z-20 mb-1 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-sm text-background opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
