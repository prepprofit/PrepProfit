'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useActionError } from '@/lib/i18n/use-action-error';
import { bpsToRatePercent } from '@/lib/validation/vat-categories';
import {
  createVatCategoryAction,
  deleteVatCategoryAction,
  updateVatCategoryAction,
} from './vat-actions';

export type VatCategoryRow = {
  id: string;
  name: string;
  rateBps: number;
  isDefault: boolean;
};

/**
 * Purchase VAT bands. VAT on what you BUY depends on the goods (in Finland food is
 * 14%, alcohol and non-food 25.5%; other countries band differently), so the rates
 * live in an editable per-org list rather than in one global setting. A band is
 * picked per ingredient in the supplier dialog.
 *
 * Deliberately NOT a tax engine: no effective dates, no jurisdictions. A rate here
 * is used at one moment only — converting an incl.-VAT supplier quote into the
 * excl.-VAT cost we store.
 */
export function VatCategoriesSection({
  categories,
}: {
  categories: VatCategoryRow[];
}) {
  const t = useTranslations('settings.vatCategories');
  const actionError = useActionError();
  const router = useRouter();
  // No local copy of the list: each action revalidates `/settings` and we refresh,
  // so the rendered bands are always the server's, never an optimistic guess that
  // could hand a fabricated id to the next delete.
  const rows = categories;
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [ratePercent, setRatePercent] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const resetDraft = () => {
    setEditingId(null);
    setName('');
    setRatePercent('');
  };

  const onEdit = (row: VatCategoryRow) => {
    setError(null);
    setEditingId(row.id);
    setName(row.name);
    setRatePercent(bpsToRatePercent(row.rateBps));
  };

  const onSubmit = () => {
    const input = { name: name.trim(), ratePercent };
    if (input.name === '' || ratePercent.trim() === '') {
      setError(actionError('INVALID_INPUT'));
      return;
    }
    setError(null);
    const id = editingId;
    startTransition(async () => {
      const result = id
        ? await updateVatCategoryAction(id, input)
        : await createVatCategoryAction(input);
      if (!result.ok) {
        setError(actionError(result.code));
        return;
      }
      resetDraft();
      router.refresh();
    });
  };

  const onDelete = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteVatCategoryAction(id);
      if (result.ok) {
        if (editingId === id) resetDraft();
        router.refresh();
      } else {
        setError(actionError(result.code));
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <ul className="flex flex-col divide-y divide-border">
          {rows.length === 0 && (
            <li className="py-3 text-sm text-muted-foreground">{t('empty')}</li>
          )}
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm text-foreground">{row.name}</span>
                {row.isDefault && (
                  <span className="text-xs text-muted-foreground">{t('default')}</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <span className="tabular-nums text-sm text-foreground">
                  {t('percent', { rate: bpsToRatePercent(row.rateBps) })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('edit')}
                  title={t('edit')}
                  disabled={pending}
                  onClick={() => onEdit(row)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('delete')}
                  title={t('delete')}
                  disabled={pending}
                  onClick={() => onDelete(row.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>

        {/* Nested inside the settings <form> is illegal HTML — this is its own. */}
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <div className="flex min-w-40 flex-1 flex-col gap-1.5">
            <Label htmlFor="vat-name">{t('name')}</Label>
            <Input
              id="vat-name"
              placeholder={t('namePlaceholder')}
              value={name}
              disabled={pending}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex w-28 flex-col gap-1.5">
            <Label htmlFor="vat-rate">{t('rate')}</Label>
            <Input
              id="vat-rate"
              inputMode="decimal"
              placeholder="14"
              className="text-right tabular-nums"
              value={ratePercent}
              disabled={pending}
              onChange={(e) => setRatePercent(e.target.value)}
            />
          </div>
          <Button type="button" variant="outline" disabled={pending} onClick={onSubmit}>
            {editingId ? <Pencil className="size-4" /> : <Plus className="size-4" />}
            {editingId ? t('save') : t('add')}
          </Button>
          {editingId && (
            <Button type="button" variant="ghost" disabled={pending} onClick={resetDraft}>
              {t('cancel')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
