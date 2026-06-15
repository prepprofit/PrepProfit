'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { Ingredient } from '@/lib/db/schema';
import { DIMENSIONS } from '@/lib/validation/ingredients';
import { centsToAmountInput, parseMoneyToCents } from '@/lib/format/money';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import {
  createIngredientAction,
  deleteIngredientAction,
  updateIngredientAction,
} from '@/app/(app)/ingredients/actions';

type Dimension = Ingredient['dimension'];

type Draft = {
  name: string;
  dimension: Dimension;
  priceText: string;
  supplier: string;
};

/** The price reference unit per dimension (prices are stored per kg / litre / piece). */
const PER_UNIT_SUFFIX: Record<Dimension, string> = {
  weight: '/kg',
  volume: '/l',
  count: '/pc',
};

function draftFromRow(row: Ingredient): Draft {
  return {
    name: row.name,
    dimension: row.dimension,
    priceText: centsToAmountInput(row.priceCents),
    supplier: row.supplier ?? '',
  };
}

function emptyDraft(): Draft {
  return { name: '', dimension: 'weight', priceText: '', supplier: '' };
}

function draftToInput(draft: Draft) {
  return {
    name: draft.name.trim(),
    dimension: draft.dimension,
    priceCents: parseMoneyToCents(draft.priceText),
    supplier: draft.supplier.trim() === '' ? null : draft.supplier.trim(),
  };
}

type GridMeta = {
  drafts: Record<string, Draft>;
  currency: string;
  pending: boolean;
  onField: (id: string, patch: Partial<Draft>) => void;
  onCommit: (id: string) => void;
  onDelete: (id: string) => void;
  dimensionLabel: (d: Dimension) => string;
  deleteLabel: string;
};

export function IngredientGrid({
  initialIngredients,
  currency,
}: {
  initialIngredients: Ingredient[];
  currency: string;
}) {
  const t = useTranslations('ingredients');
  const tDim = useTranslations('dimensions');
  const tCommon = useTranslations('common');
  const [rows, setRows] = React.useState<Ingredient[]>(initialIngredients);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>(() =>
    Object.fromEntries(initialIngredients.map((r) => [r.id, draftFromRow(r)])),
  );
  const [newDraft, setNewDraft] = React.useState<Draft>(emptyDraft);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const confirmTarget = rows.find((r) => r.id === confirmId) ?? null;

  const dimensionLabel = React.useCallback(
    (d: Dimension) => tDim(d),
    [tDim],
  );

  const onField = React.useCallback((id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: { ...current, ...patch } };
    });
  }, []);

  const onCommit = React.useCallback(
    (id: string) => {
      const draft = drafts[id];
      const row = rows.find((r) => r.id === id);
      if (!draft || !row) return;
      const input = draftToInput(draft);
      if (input.name === '') {
        setDrafts((prev) => ({ ...prev, [id]: draftFromRow(row) }));
        return;
      }
      // Skip the round-trip when nothing actually changed.
      const unchanged =
        input.name === row.name &&
        input.dimension === row.dimension &&
        input.priceCents === row.priceCents &&
        (input.supplier ?? null) === (row.supplier ?? null);
      if (unchanged) {
        setDrafts((prev) => ({ ...prev, [id]: draftFromRow(row) }));
        return;
      }
      setError(null);
      startTransition(async () => {
        const result = await updateIngredientAction(id, input);
        if (result.ok) {
          setRows((prev) => prev.map((r) => (r.id === id ? result.data : r)));
          setDrafts((prev) => ({ ...prev, [id]: draftFromRow(result.data) }));
        } else {
          setDrafts((prev) => ({ ...prev, [id]: draftFromRow(row) }));
          setError(result.error);
        }
      });
    },
    [drafts, rows],
  );

  const requestDelete = React.useCallback((id: string) => setConfirmId(id), []);

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
      } else {
        setError(result.error);
      }
      setConfirmId(null);
    });
  }, [confirmId]);

  const onCreate = React.useCallback(() => {
    const input = draftToInput(newDraft);
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
        setError(result.error);
      }
    });
  }, [newDraft, t]);

  const columns = React.useMemo<ColumnDef<Ingredient>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        cell: ({ row, table }) => {
          const meta = table.options.meta as GridMeta;
          const draft = meta.drafts[row.original.id];
          if (!draft) return null;
          return (
            <Input
              aria-label={t('columns.name')}
              value={draft.name}
              disabled={meta.pending}
              onChange={(e) => meta.onField(row.original.id, { name: e.target.value })}
              onBlur={() => meta.onCommit(row.original.id)}
            />
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
          return (
            <Select
              aria-label={t('columns.dimension')}
              value={draft.dimension}
              disabled={meta.pending}
              onChange={(e) => {
                meta.onField(row.original.id, {
                  dimension: e.target.value as Dimension,
                });
                meta.onCommit(row.original.id);
              }}
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
      {
        id: 'price',
        header: `${t('columns.price')} · ${currency}`,
        cell: ({ row, table }) => {
          const meta = table.options.meta as GridMeta;
          const draft = meta.drafts[row.original.id];
          if (!draft) return null;
          return (
            <div className="flex items-center gap-1.5">
              <Input
                aria-label={t('columns.price')}
                inputMode="decimal"
                className="w-28"
                value={draft.priceText}
                disabled={meta.pending}
                onChange={(e) =>
                  meta.onField(row.original.id, { priceText: e.target.value })
                }
                onBlur={() => meta.onCommit(row.original.id)}
              />
              <span className="text-xs text-muted-foreground">
                {PER_UNIT_SUFFIX[draft.dimension]}
              </span>
            </div>
          );
        },
      },
      {
        id: 'supplier',
        header: t('columns.supplier'),
        cell: ({ row, table }) => {
          const meta = table.options.meta as GridMeta;
          const draft = meta.drafts[row.original.id];
          if (!draft) return null;
          return (
            <Input
              aria-label={t('columns.supplier')}
              placeholder={t('placeholders.supplier')}
              value={draft.supplier}
              disabled={meta.pending}
              onChange={(e) =>
                meta.onField(row.original.id, { supplier: e.target.value })
              }
              onBlur={() => meta.onCommit(row.original.id)}
            />
          );
        },
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row, table }) => {
          const meta = table.options.meta as GridMeta;
          return (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={meta.deleteLabel}
              disabled={meta.pending}
              onClick={() => meta.onDelete(row.original.id)}
            >
              <Trash2 className="size-4" />
            </Button>
          );
        },
      },
    ],
    [t, currency],
  );

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: {
      drafts,
      currency,
      pending,
      onField,
      onCommit,
      onDelete: requestDelete,
      dimensionLabel,
      deleteLabel: t('actions.delete'),
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

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full border-collapse text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground"
                  >
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
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
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  {t('empty')}
                </td>
              </tr>
            )}
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-border last:border-0 align-top"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add a new ingredient */}
      <div className="rounded-xl border border-dashed border-border bg-surface p-3">
        <div
          className={cn(
            'grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto_1fr_auto] sm:items-center',
          )}
        >
          <Input
            aria-label={t('columns.name')}
            placeholder={t('placeholders.name')}
            value={newDraft.name}
            disabled={pending}
            onChange={(e) => setNewDraft((d) => ({ ...d, name: e.target.value }))}
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
            />
            <span className="text-xs text-muted-foreground">
              {PER_UNIT_SUFFIX[newDraft.dimension]}
            </span>
          </div>
          <Input
            aria-label={t('columns.supplier')}
            placeholder={t('placeholders.supplier')}
            value={newDraft.supplier}
            disabled={pending}
            onChange={(e) =>
              setNewDraft((d) => ({ ...d, supplier: e.target.value }))
            }
          />
          <Button type="button" onClick={onCreate} disabled={pending}>
            <Plus className="size-4" />
            {t('actions.add')}
          </Button>
        </div>
      </div>

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
    </div>
  );
}
