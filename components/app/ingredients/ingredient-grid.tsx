'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import {
  Droplet,
  Hash,
  Pencil,
  Plus,
  Scale,
  ShieldAlert,
  Trash2,
  Truck,
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
  createIngredientAction,
  deleteIngredientAction,
  updateIngredientAction,
} from '@/app/(app)/ingredients/actions';
import { IngredientAllergenDialog } from '@/components/app/ingredients/ingredient-allergen-dialog';
import { IngredientCatalogDialog } from '@/components/app/ingredients/ingredient-catalog-dialog';
import { IngredientSupplierDialog } from '@/components/app/ingredients/ingredient-supplier-dialog';
import { AddToTaskListMenu } from '@/components/app/tasks/add-to-task-list-menu';
import type { AllergenTag } from '@/lib/data/allergens';
import type { SupplierPriceBasis } from '@/lib/calculations/purchasePrice';
import type { DefaultSupplierSummary } from '@/lib/data/ingredient-suppliers';

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
 * The READ-state type pill. Colour encodes the UNIT SYSTEM — the one place on this
 * row where colour earns its keep, so a manager scanning the list sees at a glance
 * which ingredients are weighed, poured, or counted. Deliberately NOT accent orange:
 * the brand orange stays reserved for the single primary action (Add) and active nav.
 */
const DIMENSION_PILL: Record<
  Dimension,
  { icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  weight: {
    icon: Scale,
    className: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  },
  volume: {
    icon: Droplet,
    className: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  },
  count: {
    icon: Hash,
    className: 'bg-surface-2 text-muted-foreground',
  },
};

function draftFromRow(row: IngredientRow): Draft {
  return {
    name: row.name,
    dimension: row.dimension,
    priceText: row.priceCents != null ? centsToAmountInput(row.priceCents) : '',
  };
}

function emptyDraft(): Draft {
  return { name: '', dimension: 'weight', priceText: '' };
}

/** Operational fields only — what a kitchen edit sends (no price, no supplier). */
function operationalInput(draft: Draft) {
  return {
    name: draft.name.trim(),
    dimension: draft.dimension,
  };
}

/** Full input including price — only built/sent for managers. */
function draftToInput(draft: Draft) {
  return { ...operationalInput(draft), priceCents: parseMoneyToCents(draft.priceText) };
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
  onEditAllergens: (id: string) => void;
  /** True when the ingredient's allergens have NOT been reviewed yet. */
  unreviewedAllergens: (id: string) => boolean;
  /**
   * Manager-only (Sprint 6 D7): true when a "reorder from ingredient" task may be
   * offered for this row — i.e. the viewer sees costs AND the row is at/below its
   * low-stock threshold. The reorder task itself is money-free.
   */
  canReorder: (id: string) => boolean;
  dimensionLabel: (d: Dimension) => string;
  dimensionPillLabel: (d: Dimension) => string;
  editLabel: string;
  saveLabel: string;
  cancelLabel: string;
  deleteLabel: string;
  needsPricingLabel: string;
  allergensLabel: string;
  allergensUnreviewedLabel: string;
  // Suppliers (Sprint 7, manager-only).
  canManageSuppliers: boolean;
  onEditSupplier: (id: string) => void;
  supplierName: (id: string) => string | null;
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
  taxRateBps = null,
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
  /** The org's VAT rate in basis points; null = not configured (manager-only). */
  taxRateBps?: number | null;
}) {
  const t = useTranslations('ingredients');
  const flashId = useRowHighlight(highlightId, 'ingredient-row-');
  const tDim = useTranslations('dimensions');
  const tCommon = useTranslations('common');
  const tAllergens = useTranslations('allergens');
  const tSuppliers = useTranslations('suppliers.ingredientEditor');
  const actionError = useActionError();
  const [rows, setRows] = React.useState<IngredientRow[]>(initialIngredients);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>(() =>
    Object.fromEntries(initialIngredients.map((r) => [r.id, draftFromRow(r)])),
  );
  const [newDraft, setNewDraft] = React.useState<Draft>(emptyDraft);
  const [query, setQuery] = React.useState('');
  // Needs-pricing rows float to the top; the rest stay alphabetical.
  const visibleRows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(b.needsPricing) - Number(a.needsPricing) ||
          a.name.localeCompare(b.name),
      );
  }, [rows, query]);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
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

  const confirmTarget = rows.find((r) => r.id === confirmId) ?? null;
  const allergenTarget = rows.find((r) => r.id === allergenEditId) ?? null;
  const supplierTarget = rows.find((r) => r.id === supplierEditId) ?? null;

  const dimensionLabel = React.useCallback((d: Dimension) => tDim(d), [tDim]);
  const dimensionPillLabel = React.useCallback(
    (d: Dimension) => t(`typePill.${d}`),
    [t],
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

  const requestDelete = React.useCallback((id: string) => setConfirmId(id), []);
  const editAllergens = React.useCallback((id: string) => setAllergenEditId(id), []);
  const editSupplier = React.useCallback((id: string) => setSupplierEditId(id), []);
  const unreviewedAllergens = React.useCallback(
    (id: string) => reviewed[id] !== true,
    [reviewed],
  );
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
    setError(null);
    startTransition(async () => {
      const result = await deleteIngredientAction(id);
      if (result.ok) {
        setRows((prev) => prev.filter((r) => r.id !== id));
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setEditingId((prev) => (prev === id ? null : prev));
      } else {
        setError(actionError(result.code));
      }
      setConfirmId(null);
    });
  }, [confirmId, actionError]);

  const onCreate = React.useCallback(() => {
    // Kitchen creates operationally (no price); manager may set an opening price.
    const input = canSeeCosts ? draftToInput(newDraft) : operationalInput(newDraft);
    if (input.name === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createIngredientAction(input);
      if (result.ok) {
        setRows((prev) => [...prev, result.data]);
        setDrafts((prev) => ({ ...prev, [result.data.id]: draftFromRow(result.data) }));
        setNewDraft(emptyDraft());
      } else {
        setError(actionError(result.code));
      }
    });
  }, [newDraft, t, actionError, canSeeCosts]);

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
            <div className="flex min-w-44 flex-col gap-1">
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
                <span className="font-medium text-foreground">{row.original.name}</span>
              )}
              {row.original.needsPricing && (
                <span
                  className="inline-flex w-fit items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                  title={meta.needsPricingLabel}
                >
                  {meta.needsPricingLabel}
                </span>
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
            const pill = DIMENSION_PILL[row.original.dimension];
            const Icon = pill.icon;
            return (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                  pill.className,
                )}
                title={meta.dimensionLabel(row.original.dimension)}
              >
                <Icon className="size-3" />
                {meta.dimensionPillLabel(row.original.dimension)}
              </span>
            );
          }
          return (
            <Select
              aria-label={t('columns.dimension')}
              className="w-32"
              value={draft.dimension}
              disabled={meta.pending}
              onChange={(e) =>
                meta.onField(row.original.id, {
                  dimension: e.target.value as Dimension,
                })
              }
            >
              {DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {meta.dimensionLabel(d)}
                </option>
              ))}
            </Select>
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
                  return (
                    <div className="flex items-baseline justify-end gap-1 tabular-nums">
                      <span className="text-foreground">
                        {formatMoney(row.original.priceCents ?? 0, meta.currency)}
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
                    <span className="text-xs text-muted-foreground">
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
            return <span className="text-sm text-muted-foreground">{name ?? '—'}</span>;
          }
          // Stays a TOGGLE in both row states: supplier editing is its own flow
          // (product name, case pack, VAT), never an inline field.
          return (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={meta.pending}
                onClick={() => meta.onEditSupplier(row.original.id)}
              >
                <Truck className="size-4" />
                <span className="max-w-[10rem] truncate">
                  {name ?? meta.noSupplierLabel}
                </span>
              </Button>
              {hasPending && (
                <span
                  className="inline-flex w-fit items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                  title={meta.pendingCostLabel}
                >
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
                  size="sm"
                  disabled={meta.pending}
                  onClick={() => meta.onCancel(id)}
                >
                  {meta.cancelLabel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={meta.pending}
                  onClick={() => meta.onSave(id)}
                >
                  {meta.saveLabel}
                </Button>
              </div>
            );
          }
          return (
            <div className="flex items-center justify-end gap-1">
              {meta.canReorder(id) && (
                <AddToTaskListMenu kind="reorder" sourceId={id} />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={meta.allergensLabel}
                title={
                  meta.unreviewedAllergens(id)
                    ? meta.allergensUnreviewedLabel
                    : meta.allergensLabel
                }
                disabled={meta.pending}
                onClick={() => meta.onEditAllergens(id)}
              >
                <ShieldAlert
                  className={cn(
                    'size-4',
                    meta.unreviewedAllergens(id) && 'text-amber-600 dark:text-amber-400',
                  )}
                />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={meta.editLabel}
                title={meta.editLabel}
                disabled={meta.pending}
                onClick={() => meta.onEdit(id)}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={meta.deleteLabel}
                title={meta.deleteLabel}
                disabled={meta.pending}
                onClick={() => meta.onDelete(id)}
              >
                <Trash2 className="size-4" />
              </Button>
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
      onEditAllergens: editAllergens,
      unreviewedAllergens,
      canReorder,
      dimensionLabel,
      dimensionPillLabel,
      editLabel: t('actions.edit'),
      saveLabel: t('actions.save'),
      cancelLabel: t('actions.cancel'),
      deleteLabel: t('actions.delete'),
      needsPricingLabel: t('needsPricing'),
      allergensLabel: tAllergens('editor.open'),
      allergensUnreviewedLabel: tAllergens('editor.unreviewed'),
      canManageSuppliers: canSeeCosts,
      onEditSupplier: editSupplier,
      supplierName,
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

      {/* Search + add side by side: search left, new-ingredient field right. */}
      <div className="grid grid-cols-1 items-center gap-3 lg:grid-cols-2">
      <Input
        type="search"
        aria-label={t('searchPlaceholder')}
        placeholder={t('searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="rounded-xl border border-dashed border-border bg-surface p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('addTitle')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setCatalogOpen(true)}
          >
            {t('catalog.open')}
          </Button>
        </div>
        <div
          className={cn(
            'grid grid-cols-1 gap-2 sm:items-center',
            canSeeCosts
              ? 'sm:grid-cols-[1fr_auto_auto_auto]'
              : 'sm:grid-cols-[1fr_auto_auto]',
          )}
        >
          <Input
            aria-label={t('columns.name')}
            placeholder={t('placeholders.name')}
            value={newDraft.name}
            disabled={pending}
            onChange={(e) => setNewDraft((d) => ({ ...d, name: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreate();
            }}
          />
          <Select
            aria-label={t('columns.dimension')}
            value={newDraft.dimension}
            disabled={pending}
            onChange={(e) =>
              setNewDraft((d) => ({ ...d, dimension: e.target.value as Dimension }))
            }
          >
            {DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {tDim(d)}
              </option>
            ))}
          </Select>
          {canSeeCosts && (
            <div className="flex items-center gap-1.5">
              <Input
                aria-label={t('columns.price')}
                inputMode="decimal"
                placeholder="0.00"
                className="w-24"
                value={newDraft.priceText}
                disabled={pending}
                onChange={(e) =>
                  setNewDraft((d) => ({ ...d, priceText: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCreate();
                }}
              />
              <span className="text-xs text-muted-foreground">
                {PER_UNIT_SUFFIX[newDraft.dimension]}
              </span>
            </div>
          )}
          {/* The ONE primary (orange) action on this screen. */}
          <Button type="button" onClick={onCreate} disabled={pending}>
            <Plus className="size-4" />
            {t('actions.add')}
          </Button>
        </div>
      </div>

      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className={cn(
                      'px-2.5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground first:pl-4 last:pr-4',
                      header.column.id === 'price' && 'text-right',
                    )}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
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
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
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
                    editing && 'bg-accent-500/5',
                    flashId === row.original.id && 'bg-accent-500/10',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-2.5 py-3.5 first:pl-4 last:pr-4"
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

      <ConfirmDialog
        open={confirmId !== null}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { name: confirmTarget?.name ?? '' })}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmId(null)}
      />

      <IngredientCatalogDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onCreated={(ingredient, tags) => {
          // Kitchen rows carry no price keys (Sprint F4) — IngredientRow allows that.
          const row = ingredient as IngredientRow;
          setRows((prev) => [...prev, row]);
          setDrafts((prev) => ({ ...prev, [row.id]: draftFromRow(row) }));
          setAllergens((prev) => ({ ...prev, [row.id]: tags }));
          // Seeded allergens are typical + UNREVIEWED until a human reviews them.
          setReviewed((prev) => ({ ...prev, [row.id]: false }));
        }}
      />

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

      {canSeeCosts && supplierTarget && (
        <IngredientSupplierDialog
          open={supplierEditId !== null}
          ingredientId={supplierTarget.id}
          ingredientName={supplierTarget.name}
          dimension={supplierTarget.dimension}
          currency={currency}
          taxRateBps={taxRateBps}
          supplierNames={supplierNames}
          pricePrefs={pricePrefs}
          initialLink={supplierLinks[supplierTarget.id] ?? null}
          pendingPriceCents={supplierTarget.pendingPriceCents ?? null}
          onClose={() => setSupplierEditId(null)}
          onSaved={(summary, prefs) => {
            const id = supplierTarget.id;
            setSupplierLinks((prev) => ({ ...prev, [id]: summary }));
            setPricePrefs((prev) => ({ ...prev, [summary.supplierName]: prefs }));
            setRows((prev) =>
              prev.map((r) =>
                r.id === id ? { ...r, supplier: summary.supplierName } : r,
              ),
            );
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
                r.id === id ? { ...r, priceCents, pendingPriceCents: null } : r,
              ),
            );
            setDrafts((prev) => {
              const row = rows.find((r) => r.id === id);
              return row
                ? { ...prev, [id]: draftFromRow({ ...row, priceCents }) }
                : prev;
            });
          }}
        />
      )}
    </div>
  );
}
