'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  Eye,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { Ingredient } from '@/lib/db/schema';
import { DIMENSIONS } from '@/lib/validation/ingredients';
import { isLowStock } from '@/lib/calculations/inventory';
import { displayPriceCents } from '@/lib/ingredients/incomplete';
import {
  compareIngredients,
  DEFAULT_INGREDIENT_SORT,
  INGREDIENT_SORT_COLUMNS,
  nextSort,
  type IngredientSort,
  type IngredientSortColumn,
  type SortDirection,
} from '@/lib/ingredients/sort';
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
import { IngredientSupplierDialog } from '@/components/app/ingredients/ingredient-supplier-dialog';
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
export type IngredientRow = Omit<Ingredient, 'priceCents' | 'pendingPriceCents'> & {
  priceCents?: number;
  pendingPriceCents?: number | null;
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

/**
 * Per-column cell layout. Desktop: the name takes ~60% of the row and every other
 * column shrinks to its content, grouped on the right. In a list narrower than 48rem each row becomes a
 * compact card — name, date and price on top; type / supplier / actions below —
 * so nothing is clipped or needs sideways scrolling.
 */
const CELL_CLASS: Record<string, string> = {
  name: '@3xl:w-[60%] @max-3xl:col-span-2 @max-3xl:col-start-1 @max-3xl:row-start-1',
  updated: '@3xl:w-px @3xl:px-2 @3xl:whitespace-nowrap @max-3xl:col-span-2 @max-3xl:col-start-1 @max-3xl:row-start-2',
  price: '@3xl:w-px @3xl:px-2 @3xl:whitespace-nowrap @3xl:text-right @max-3xl:col-start-3 @max-3xl:row-span-2 @max-3xl:row-start-1 @max-3xl:self-start',
  dimension: '@3xl:w-px @3xl:px-2 @3xl:whitespace-nowrap @max-3xl:col-start-1 @max-3xl:row-start-3 @max-3xl:mt-1',
  supplier: '@3xl:w-px @3xl:pl-5 @3xl:pr-2 @max-3xl:col-start-2 @max-3xl:row-start-3 @max-3xl:mt-1 @max-3xl:min-w-0',
  actions: '@3xl:w-px @3xl:pl-2 @3xl:whitespace-nowrap @max-3xl:col-start-3 @max-3xl:row-start-3 @max-3xl:mt-1 @max-3xl:justify-self-end',
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
function formatUpdated(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

type GridMeta = {
  drafts: Record<string, Draft>;
  currency: string;
  canSeeCosts: boolean;
  pending: boolean;
  /** The one row currently in EDIT state; every other row renders as plain text. */
  editingId: string | null;
  onField: (id: string, patch: Partial<Draft>) => void;
  onEdit: (id: string) => void;
  onSave: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  /** Opens the read-only details popup (price, supplier, nutrition, allergens). */
  onView: (id: string) => void;
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
  changeTypeLabel: string;
  editLabel: string;
  saveLabel: string;
  cancelLabel: string;
  deleteLabel: string;
  viewLabel: string;
  needsPricingLabel: string;
  missingPriceLabel: string;
  // Suppliers (Sprint 7, manager-only).
  canManageSuppliers: boolean;
  onEditSupplier: (id: string) => void;
  supplierName: (id: string) => string | null;
  /** True when the supplier entry has no usable price yet (shown quietly, never blocking). */
  pricingIncomplete: (id: string) => boolean;
  pricingIncompleteLabel: string;
  supplierLabel: string;
  noSupplierLabel: string;
  pendingCostLabel: string;
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
  /**
   * Client-side sort over the loaded list, driven by the column headings (click to
   * sort, click again to reverse). Rows whose COST can't be trusted stay pinned on
   * top whatever the column (decision D2) — see `compareIngredients`.
   */
  const visibleRows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .sort((a, b) => compareIngredients(a, b, sort, canSeeCosts));
  }, [rows, query, sort, canSeeCosts]);
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
  // Suppliers (Sprint 7, manager-only): the default link per ingredient + which
  // row's supplier editor is open.
  const [supplierLinks, setSupplierLinks] = React.useState<
    Record<string, DefaultSupplierSummary | null>
  >(() => ({ ...initialSupplierLinks }));
  const [supplierEditId, setSupplierEditId] = React.useState<string | null>(null);
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
      // Switching rows discards the previous row's uncommitted edits — nothing was
      // ever sent, so the only state to clear is the local draft.
      setEditingId((prev) => {
        if (prev && prev !== id) resetDraft(prev);
        return id;
      });
      resetDraft(id);
    },
    [resetDraft],
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
  const editSupplier = React.useCallback((id: string) => setSupplierEditId(id), []);
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

  const columns = React.useMemo<ColumnDef<IngredientRow>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        cell: ({ row, table }) => {
          const meta = table.options.meta as GridMeta;
          const draft = meta.drafts[row.original.id];
          if (!draft) return null;
          const editing = meta.editingId === row.original.id;
          return (
            <div className="flex min-w-0 flex-col gap-0.5 @3xl:min-w-[10rem]">
              {editing ? (
                <Input
                  autoFocus
                  aria-label={t('columns.name')}
                  value={draft.name}
                  disabled={meta.pending}
                  onChange={(e) =>
                    meta.onField(row.original.id, { name: e.target.value })
                  }
                />
              ) : (
                <span className="break-words text-lg font-semibold leading-snug text-foreground">
                  {row.original.name}
                </span>
              )}
              {/* Managers see pricing status under the price; kitchen has no price column. */}
              {row.original.needsPricing && !meta.canSeeCosts && (
                <span className="text-xs text-muted-foreground">{meta.needsPricingLabel}</span>
              )}
            </div>
          );
        },
      },
      {
        id: 'dimension',
        header: t('columns.dimension'),
        cell: ({ row, table }) => {
          const meta = table.options.meta as GridMeta;
          const draft = meta.drafts[row.original.id];
          if (!draft) return null;
          if (meta.editingId !== row.original.id) {
            return (
              <button
                type="button"
                disabled={meta.pending}
                onClick={() => meta.onEdit(row.original.id)}
                aria-label={`${meta.changeTypeLabel}: ${row.original.name} — ${meta.dimensionLabel(row.original.dimension)}`}
                title={meta.changeTypeLabel}
                // Small and neutral; the invisible ::after pad keeps a ~40 px click target.
                className="relative inline-flex h-6 min-w-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-border bg-surface-2 px-1.5 text-[13px] font-medium text-muted-foreground after:absolute after:-inset-x-1.5 after:-inset-y-2 hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                {meta.dimensionPillLabel(row.original.dimension)}
              </button>
            );
          }
          const lockReason = meta.typeLockReason(row.original.id);
          return (
            <div className="flex w-40 flex-col gap-1">
              <Select
                aria-label={t('columns.dimension')}
                aria-describedby={lockReason ? `type-lock-${row.original.id}` : undefined}
                className="w-32"
                value={draft.dimension}
                disabled={meta.pending || lockReason !== null}
                onChange={(e) =>
                  meta.onField(row.original.id, {
                    dimension: e.target.value as Dimension,
                  })
                }
              >
                {DIMENSIONS.map((d) => (
                  <option key={d} value={d}>
                    {meta.dimensionLabel(d)} ({meta.dimensionPillLabel(d)})
                  </option>
                ))}
              </Select>
              {lockReason ? (
                <span id={`type-lock-${row.original.id}`} className="text-sm leading-snug text-muted-foreground">
                  {lockReason}
                </span>
              ) : draft.dimension !== row.original.dimension && meta.canSeeCosts ? (
                <span className="text-sm leading-snug text-amber-800 dark:text-amber-300">
                  {t('typeLock.checkPrice', { unit: meta.dimensionPillLabel(draft.dimension) })}
                </span>
              ) : null}
            </div>
          );
        },
      },
      // Price is manager-only (Sprint F4) — kitchen rows have no price at all.
      ...(canSeeCosts
        ? [
            {
              id: 'price',
              header: t('columns.price'),
              cell: ({ row, table }) => {
                const meta = table.options.meta as GridMeta;
                const draft = meta.drafts[row.original.id];
                if (!draft) return null;
                if (meta.editingId !== row.original.id) {
                  // Unpriced reads "—", never €0.00; a real recorded zero still shows €0.00.
                  const priceCents = displayPriceCents(row.original);
                  if (priceCents === null) {
                    return (
                      <div className="flex flex-col items-end leading-tight">
                        <span aria-hidden className="text-lg text-muted-foreground">—</span>
                        {row.original.needsPricing ? (
                          <span className="whitespace-nowrap text-xs font-medium text-amber-800 dark:text-amber-300">
                            {meta.needsPricingLabel}
                          </span>
                        ) : (
                          <span className="sr-only">{meta.missingPriceLabel}</span>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div className="flex items-baseline justify-end gap-0.5 whitespace-nowrap tabular-nums">
                      <span className="text-lg font-medium leading-tight text-foreground">
                        {formatMoney(priceCents, meta.currency)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {PER_UNIT_SUFFIX[row.original.dimension]}
                      </span>
                    </div>
                  );
                }
                return (
                  <div className="flex items-center justify-end gap-1.5">
                    <Input
                      aria-label={t('columns.price')}
                      inputMode="decimal"
                      className="w-28 text-right tabular-nums"
                      value={draft.priceText}
                      disabled={meta.pending}
                      onChange={(e) =>
                        meta.onField(row.original.id, { priceText: e.target.value })
                      }
                    />
                    <span className="text-sm text-muted-foreground">
                      {PER_UNIT_SUFFIX[draft.dimension]}
                    </span>
                  </div>
                );
              },
            } satisfies ColumnDef<IngredientRow>,
          ]
        : []),
      {
        id: 'supplier',
        header: t('columns.supplier'),
        cell: ({ row, table }) => {
          const meta = table.options.meta as GridMeta;
          const name = meta.supplierName(row.original.id);
          const hasPending =
            meta.canManageSuppliers && row.original.pendingPriceCents != null;
          // Suppliers are MANAGER-ONLY (Sprint 7): a manager edits the default
          // supplier + pack via the dialog; kitchen sees the name read-only.
          if (!meta.canManageSuppliers) {
            return (
              <span className="block truncate text-[13px] text-muted-foreground @3xl:max-w-[9rem]" title={name ?? undefined}>
                {name ?? '—'}
              </span>
            );
          }
          // Stays a TOGGLE in both row states: supplier editing is its own flow
          // (product name, case pack, VAT), never an inline field.
          return (
            <div className="flex min-w-0 flex-col items-start gap-0.5">
              <button
                type="button"
                disabled={meta.pending}
                title={`${meta.supplierLabel}: ${name ?? meta.noSupplierLabel}`}
                aria-haspopup="dialog"
                onClick={() => meta.onEditSupplier(row.original.id)}
                // Compact text + caret; the invisible ::after pad keeps a comfortable target.
                className={cn(
                  'relative inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded text-[13px] after:absolute after:-inset-x-1.5 after:-inset-y-2.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default @3xl:max-w-[9rem]',
                  name ? 'text-foreground/80' : 'text-muted-foreground',
                )}
              >
                <span className="truncate">{name ?? meta.noSupplierLabel}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
              {!hasPending && meta.pricingIncomplete(row.original.id) && (
                <span className="text-xs text-muted-foreground @3xl:whitespace-nowrap">
                  {meta.pricingIncompleteLabel}
                </span>
              )}
              {hasPending && (
                <span className="text-xs font-medium text-amber-800 @3xl:whitespace-nowrap dark:text-amber-300">
                  {meta.pendingCostLabel}
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: 'updated',
        header: t('columns.updated'),
        // System-set, never editable — it is the audit trail of the row, not a field.
        cell: ({ row }) => (
          <span
            className="whitespace-nowrap text-xs text-muted-foreground"
            suppressHydrationWarning
          >
            {formatUpdated(row.original.updatedAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row, table }) => {
          const meta = table.options.meta as GridMeta;
          const id = row.original.id;
          if (meta.editingId === id) {
            return (
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={meta.pending}
                  onClick={() => meta.onCancel(id)}
                  className="text-base"
                >
                  {meta.cancelLabel}
                </Button>
                <Button
                  type="button"
                  disabled={meta.pending}
                  onClick={() => meta.onSave(id)}
                  className="text-base"
                >
                  {meta.saveLabel}
                </Button>
              </div>
            );
          }
          return (
            <div className="-my-1 -mr-1.5 flex items-center justify-end">
              {meta.canReorder(id) && (
                <AddToTaskListMenu kind="reorder" sourceId={id} />
              )}
              <IconAction
                id={`ingredient-view-${id}`}
                label={meta.viewLabel}
                disabled={meta.pending}
                onClick={() => meta.onView(id)}
              >
                <Eye />
              </IconAction>
              <IconAction
                label={meta.editLabel}
                disabled={meta.pending}
                onClick={() => meta.onEdit(id)}
              >
                <Pencil />
              </IconAction>
              <IconAction
                label={meta.deleteLabel}
                disabled={meta.pending}
                onClick={() => meta.onDelete(id)}
              >
                <Trash2 />
              </IconAction>
            </div>
          );
        },
      },
    ],
    [t, canSeeCosts],
  );

  const table = useReactTable({
    data: visibleRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: {
      drafts,
      currency,
      canSeeCosts,
      pending,
      editingId,
      onField,
      onEdit,
      onSave,
      onCancel,
      onDelete: requestDelete,
      onView: viewDetails,
      canReorder,
      dimensionLabel,
      dimensionPillLabel,
      typeLockReason,
      changeTypeLabel: t('typeLock.change'),
      editLabel: t('actions.edit'),
      saveLabel: t('actions.save'),
      cancelLabel: t('actions.cancel'),
      deleteLabel: t('actions.delete'),
      viewLabel: t('actions.view'),
      needsPricingLabel: t('needsPricing'),
      missingPriceLabel: t('missingPrice'),
      canManageSuppliers: canSeeCosts,
      onEditSupplier: editSupplier,
      supplierName,
      pricingIncomplete: (id: string) => {
        const link = supplierLinks[id];
        return link != null && link.packPriceCents == null;
      },
      pricingIncompleteLabel: tSuppliers('noPriceYet'),
      supplierLabel: t('columns.supplier'),
      noSupplierLabel: tSuppliers('none'),
      pendingCostLabel: tSuppliers('pendingBadge'),
    } satisfies GridMeta,
  });

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
        search field owns the row and the two add paths sit to the right. Adding is
        occasional — one click away, never cluttering the everyday workspace.
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
        <div className="flex items-center gap-2 sm:justify-end">
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

      {/*
        Layout follows the LIST's own width (container query), not the viewport: the
        sidebar appears at lg, so a narrow list can sit on a wide screen.
      */}
      <div className="@container flex flex-col gap-3">
        {/* Column headings sort on wide lists; narrow lists get the same sort as one select. */}
        <label className="flex items-center gap-2 text-sm text-muted-foreground @3xl:hidden">
          <span className="shrink-0">{t('sort.label')}</span>
          <Select
            className="h-9 flex-1 text-sm"
            value={`${sort.column}:${sort.direction}`}
            onChange={(e) => {
              const [column, direction] = e.target.value.split(':') as [IngredientSortColumn, SortDirection];
              setSort({ column, direction });
            }}
          >
            {INGREDIENT_SORT_COLUMNS.filter((c) => canSeeCosts || c !== 'price').flatMap((c) =>
              (['asc', 'desc'] as const).map((d) => (
                <option key={`${c}:${d}`} value={`${c}:${d}`}>
                  {t('sort.option', { column: t(`columns.${c}`), direction: t(`sort.${d}`) })}
                </option>
              )),
            )}
          </Select>
        </label>

        <Card className="overflow-x-auto">
          <table className="w-full border-collapse text-base">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-border @max-3xl:hidden">
                  {hg.headers.map((header) => (
                    <th
                      key={header.id}
                      aria-sort={
                        sort.column === header.column.id
                          ? sort.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : undefined
                      }
                      className={cn(
                        'px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground first:pl-4 last:pr-4',
                        CELL_CLASS[header.column.id],
                        header.column.id === 'price' && 'text-right',
                      )}
                    >
                      {isSortColumn(header.column.id) ? (
                        <SortHeading
                          label={flexRender(header.column.columnDef.header, header.getContext())}
                          active={sort.column === header.column.id}
                          direction={sort.direction}
                          alignRight={header.column.id === 'price'}
                          ariaLabel={t('sort.by', { column: String(header.column.columnDef.header) })}
                          onClick={() =>
                            setSort((current) => nextSort(current, header.column.id as IngredientSortColumn))
                          }
                        />
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 && (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-4 py-8 text-center text-base text-muted-foreground"
                  >
                    {query ? t('noMatches') : t('empty')}
                  </td>
                </tr>
              )}
              {table.getRowModel().rows.map((row) => {
                const editing = editingId === row.original.id;
                return (
                  <tr
                    key={row.id}
                    id={`ingredient-row-${row.original.id}`}
                    // Enter saves, Esc cancels — the keyboard mirror of the two buttons.
                    onKeyDown={
                      editing
                        ? (e) => {
                            if (e.key === 'Enter') {
                              // A focused button (Save/Cancel/supplier) already acts on
                              // Enter; saving again here would double-fire.
                              if (
                                e.target instanceof HTMLElement &&
                                e.target.closest('button')
                              ) {
                                return;
                              }
                              e.preventDefault();
                              onSave(row.original.id);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              onCancel(row.original.id);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      // Hairline dividers only — no borders around individual cells.
                      'border-b border-border/60 align-middle transition-colors duration-700 last:border-0',
                      // Phones: a compact card (grid) — or a plain stack while editing.
                      editing
                        ? '@max-3xl:flex @max-3xl:flex-col @max-3xl:gap-2 @max-3xl:px-4 @max-3xl:py-3'
                        : '@max-3xl:grid @max-3xl:grid-cols-[auto_minmax(0,1fr)_auto] @max-3xl:items-center @max-3xl:gap-x-3 @max-3xl:gap-y-0.5 @max-3xl:px-4 @max-3xl:py-3',
                      editing && 'bg-accent-500/5',
                      flashId === row.original.id && 'bg-accent-500/10',
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={cn(
                          '@3xl:px-3 @3xl:py-2.5 @3xl:first:pl-4 @3xl:last:pr-4',
                          CELL_CLASS[cell.column.id],
                          (cell.column.id === 'name' || cell.column.id === 'updated') && !canSeeCosts && '@max-3xl:col-span-3',
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

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
          onEditSupplier={() => setSupplierEditId(detailsTarget.id)}
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
          currentPriceCents={supplierTarget.priceCents ?? null}
          supplierNames={supplierNames}
          pricePrefs={pricePrefs}
          initialLink={supplierLinks[supplierTarget.id] ?? null}
          pendingPriceCents={supplierTarget.pendingPriceCents ?? null}
          onClose={() => setSupplierEditId(null)}
          onSaved={(summary, prefs, savedNotice) => {
            const id = supplierTarget.id;
            setSupplierLinks((prev) => ({ ...prev, [id]: summary }));
            setPricePrefs((prev) => ({ ...prev, [summary.supplierName]: prefs }));
            setRows((prev) =>
              prev.map((r) =>
                r.id === id
                  ? { ...r, supplier: summary.supplierName, vatRateBps: summary.vatRateBps ?? r.vatRateBps }
                  : r,
              ),
            );
            if (!savedNotice.incomplete) setNotice({ message: savedNotice.message, undo: null });
          }}
          onCleared={() => {
            const id = supplierTarget.id;
            setSupplierLinks((prev) => ({ ...prev, [id]: null }));
            setRows((prev) =>
              prev.map((r) => (r.id === id ? { ...r, supplier: null } : r)),
            );
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

const isSortColumn = (id: string): id is IngredientSortColumn =>
  (INGREDIENT_SORT_COLUMNS as readonly string[]).includes(id);

/** A column heading that sorts its column: the label plus a small up/down arrow. */
function SortHeading({
  label,
  active,
  direction,
  alignRight,
  ariaLabel,
  onClick,
}: {
  label: React.ReactNode;
  active: boolean;
  direction: SortDirection;
  alignRight: boolean;
  ariaLabel: string;
  onClick: () => void;
}) {
  const Icon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1 rounded uppercase tracking-wider hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'text-foreground',
        alignRight && 'flex-row-reverse',
      )}
    >
      {label}
      <Icon className={cn('size-3.5', !active && 'opacity-40')} aria-hidden />
    </button>
  );
}
