'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Download, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  centsToAmountInput,
  formatMoney,
  parseMoneyToCents,
} from '@/lib/format/money';
import {
  createTransactionAction,
  deleteTransactionAction,
  updateTransactionAction,
} from '@/app/(app)/transactions/actions';

type TxType = 'income' | 'expense';

export type CategoryOption = { id: string; kind: TxType; label: string };
export type RecipeOption = { id: string; name: string };

export type TransactionRow = {
  id: string;
  type: TxType;
  occurredOn: string;
  amountCents: number;
  note: string | null;
  categoryId: string;
  categoryLabel: string;
  recipeId: string | null;
  recipeName: string | null;
};

type FilterState = { type: string; from: string; to: string; category: string };

/** Local calendar date 'YYYY-MM-DD' (no timezone math). */
function todayLocal(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function TransactionsView({
  currency,
  categories,
  recipes,
  rows,
  filter,
}: {
  currency: string;
  categories: CategoryOption[];
  recipes: RecipeOption[];
  rows: TransactionRow[];
  filter: FilterState;
}) {
  const t = useTranslations('finance.transactions');
  const tKind = useTranslations('finance.kind');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const firstCategoryFor = React.useCallback(
    (type: TxType) => categories.find((c) => c.kind === type)?.id ?? '',
    [categories],
  );

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [type, setType] = React.useState<TxType>('income');
  const [categoryId, setCategoryId] = React.useState(() =>
    firstCategoryFor('income'),
  );
  const [recipeId, setRecipeId] = React.useState('');
  const [occurredOn, setOccurredOn] = React.useState(todayLocal);
  const [amount, setAmount] = React.useState('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<TransactionRow | null>(
    null,
  );

  const formCategories = categories.filter((c) => c.kind === type);

  const resetForm = () => {
    setEditingId(null);
    setType('income');
    setCategoryId(firstCategoryFor('income'));
    setRecipeId('');
    setOccurredOn(todayLocal());
    setAmount('');
    setNote('');
  };

  const changeType = (next: TxType) => {
    setType(next);
    setCategoryId(firstCategoryFor(next));
    if (next === 'expense') setRecipeId('');
  };

  const startEdit = (row: TransactionRow) => {
    setEditingId(row.id);
    setType(row.type);
    setCategoryId(row.categoryId);
    setRecipeId(row.recipeId ?? '');
    setOccurredOn(row.occurredOn);
    setAmount(centsToAmountInput(row.amountCents));
    setNote(row.note ?? '');
    setError(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const amountCents = parseMoneyToCents(amount);
    if (amountCents <= 0) {
      setError(t('errors.amountRequired'));
      return;
    }
    if (!categoryId) {
      setError(t('errors.categoryRequired'));
      return;
    }
    const payload = {
      type,
      categoryId,
      recipeId: type === 'income' && recipeId ? recipeId : null,
      occurredOn,
      amountCents,
      note: note.trim() === '' ? null : note.trim(),
    };

    startTransition(async () => {
      const result = editingId
        ? await updateTransactionAction(editingId, payload)
        : await createTransactionAction(payload);
      if (result.ok) {
        resetForm();
        router.refresh();
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteTransactionAction(deleteTarget.id);
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
      setDeleteTarget(null);
    });
  };

  // Filters drive the URL so the list, export, and shareable links agree.
  const buildQuery = (next: Partial<FilterState>): string => {
    const merged = { ...filter, ...next };
    const params = new URLSearchParams();
    if (merged.type) params.set('type', merged.type);
    if (merged.from) params.set('from', merged.from);
    if (merged.to) params.set('to', merged.to);
    if (merged.category) params.set('category', merged.category);
    return params.toString();
  };

  const applyFilter = (next: Partial<FilterState>) => {
    const qs = buildQuery(next);
    startTransition(() =>
      router.push(qs ? `/transactions?${qs}` : '/transactions'),
    );
  };

  const exportQuery = buildQuery({});
  const exportHref = `/api/transactions/export${exportQuery ? `?${exportQuery}` : ''}`;
  const hasFilters = Boolean(
    filter.type || filter.from || filter.to || filter.category,
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Add / edit form */}
      <Card className="p-5">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tx-type">{t('fields.type')}</Label>
              <Select
                id="tx-type"
                value={type}
                onChange={(e) => changeType(e.target.value as TxType)}
              >
                <option value="income">{tKind('income')}</option>
                <option value="expense">{tKind('expense')}</option>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tx-category">{t('fields.category')}</Label>
              <Select
                id="tx-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                {formCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tx-date">{t('fields.date')}</Label>
              <Input
                id="tx-date"
                type="date"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tx-amount">{t('fields.amount')}</Label>
              <Input
                id="tx-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>

            {type === 'income' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tx-recipe">{t('fields.recipe')}</Label>
                <Select
                  id="tx-recipe"
                  value={recipeId}
                  onChange={(e) => setRecipeId(e.target.value)}
                >
                  <option value="">{t('noRecipe')}</option>
                  {recipes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tx-note">{t('fields.note')}</Label>
              <Input
                id="tx-note"
                placeholder={t('placeholders.note')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending}>
              <Plus className="size-4" />
              {editingId ? tCommon('save') : t('add')}
            </Button>
            {editingId && (
              <Button
                type="button"
                variant="ghost"
                onClick={resetForm}
                disabled={pending}
              >
                {tCommon('cancel')}
              </Button>
            )}
          </div>
        </form>
      </Card>

      {/* Filter bar + export */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-type">{t('fields.type')}</Label>
          <Select
            id="filter-type"
            className="w-40"
            value={filter.type}
            onChange={(e) => applyFilter({ type: e.target.value })}
          >
            <option value="">{t('filters.allTypes')}</option>
            <option value="income">{tKind('income')}</option>
            <option value="expense">{tKind('expense')}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-category">{t('fields.category')}</Label>
          <Select
            id="filter-category"
            className="w-48"
            value={filter.category}
            onChange={(e) => applyFilter({ category: e.target.value })}
          >
            <option value="">{t('filters.allCategories')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-from">{t('filters.from')}</Label>
          <Input
            id="filter-from"
            type="date"
            className="w-40"
            value={filter.from}
            onChange={(e) => applyFilter({ from: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-to">{t('filters.to')}</Label>
          <Input
            id="filter-to"
            type="date"
            className="w-40"
            value={filter.to}
            onChange={(e) => applyFilter({ to: e.target.value })}
          />
        </div>
        {hasFilters && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => applyFilter({ type: '', from: '', to: '', category: '' })}
            disabled={pending}
          >
            <X className="size-4" />
            {t('filters.clear')}
          </Button>
        )}
        <Button asChild variant="outline" className="ml-auto">
          <a href={exportHref}>
            <Download className="size-4" />
            {t('export')}
          </a>
        </Button>
      </div>

      {/* List */}
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Badge variant={row.type === 'income' ? 'positive' : 'neutral'}>
                    {tKind(row.type)}
                  </Badge>
                  <span className="truncate text-sm font-medium text-foreground">
                    {row.categoryLabel}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {row.occurredOn}
                  {row.recipeName ? ` · ${row.recipeName}` : ''}
                  {row.note ? ` · ${row.note}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={
                    row.type === 'income'
                      ? 'font-semibold text-brand-600 dark:text-brand-400'
                      : 'font-semibold text-foreground'
                  }
                >
                  {row.type === 'expense' ? '−' : ''}
                  {formatMoney(row.amountCents, currency)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('edit')}
                  disabled={pending}
                  onClick={() => startEdit(row)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('actions.delete')}
                  disabled={pending}
                  onClick={() => setDeleteTarget(row)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body')}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
