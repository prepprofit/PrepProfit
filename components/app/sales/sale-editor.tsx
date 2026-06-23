'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import type { SaleItemKind } from '@/lib/db/schema';
import type {
  SaleIngredientOption,
  SaleItemOption,
} from '@/lib/data/sales';
import { saleLineTotals, saleTotals, bpsToPercent, percentToBps } from '@/lib/calculations/tax';
import { formatMoney, parseMoneyToCents, centsToAmountInput } from '@/lib/format/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  createSaleAction,
  deleteSaleAction,
  postSaleAction,
  updateSaleAction,
} from '@/app/(app)/sales/actions';
import { useActionError } from '@/lib/i18n/use-action-error';

/** One editor line (local-only `key` for React; the payload derives from it). */
type EditorLine = {
  key: string;
  itemKind: SaleItemKind;
  itemId: string;
  itemName: string;
  quantity: number;
  unitNetCents: number;
  taxRateBps: number;
  ingredientQtyCanonical: number | null;
  available: boolean;
};

export type SaleEditorInitialLine = {
  itemKind: SaleItemKind;
  itemId: string;
  itemName: string;
  quantity: number;
  unitNetCents: number;
  taxRateBps: number;
  ingredientQtyCanonical: number | null;
  available: boolean;
};

export type SaleEditorInitial = {
  saleDate: string;
  note: string | null;
  lines: SaleEditorInitialLine[];
};

export type SaleEditorOptions = {
  recipes: SaleItemOption[];
  menus: SaleItemOption[];
  ingredients: SaleIngredientOption[];
};

let uidCounter = 0;
const uid = (): string => `line-${uidCounter++}`;

/**
 * Daily-close sale editor (Sprint 12a), manager-only. Builds the line items (recipe /
 * menu / ingredient at units × net price + tax) with a LIVE net/tax/gross preview via
 * tax.ts; Save persists the draft, Post freezes + projects revenue/stock, Delete
 * hard-deletes a draft. Every mutation carries `expectedUpdatedAt` (optimistic
 * concurrency); after each success the page refreshes for a fresh token.
 */
export function SaleEditor({
  mode,
  saleId,
  initial,
  expectedUpdatedAt,
  options,
  defaultTaxRateBps,
  currency,
}: {
  mode: 'create' | 'edit';
  saleId?: string;
  initial: SaleEditorInitial;
  expectedUpdatedAt?: string;
  options: SaleEditorOptions;
  /** Org VAT rate in bps; null = not configured (post will require it). */
  defaultTaxRateBps: number | null;
  currency: string;
}) {
  const t = useTranslations('sales');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [saleDate, setSaleDate] = React.useState(initial.saleDate);
  const [note, setNote] = React.useState(initial.note ?? '');
  const [lines, setLines] = React.useState<EditorLine[]>(
    initial.lines.map((l) => ({ ...l, key: uid() })),
  );
  const [newKind, setNewKind] = React.useState<SaleItemKind>('recipe');
  const [newItemId, setNewItemId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const dirty = (): void => setSaved(false);

  const optionsFor = (kind: SaleItemKind): SaleItemOption[] =>
    kind === 'recipe' ? options.recipes : kind === 'menu' ? options.menus : options.ingredients;

  const addLine = () => {
    const opt = optionsFor(newKind).find((o) => o.id === newItemId);
    if (!opt) return;
    setLines((prev) => [
      ...prev,
      {
        key: uid(),
        itemKind: newKind,
        itemId: opt.id,
        itemName: opt.name,
        quantity: 1,
        unitNetCents: 0,
        taxRateBps: defaultTaxRateBps ?? 0,
        ingredientQtyCanonical: newKind === 'ingredient' ? 1 : null,
        available: true,
      },
    ]);
    setNewItemId('');
    dirty();
  };

  const patchLine = (key: string, patch: Partial<EditorLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    dirty();
  };

  const removeLine = (key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
    dirty();
  };

  const totals = saleTotals(
    lines.map((l) => ({ netCents: l.quantity * l.unitNetCents, bps: l.taxRateBps })),
  );

  const buildPayload = () => ({
    saleDate,
    note: note.trim() === '' ? null : note.trim(),
    lines: lines.map((l) => ({
      itemKind: l.itemKind,
      itemRecipeId: l.itemKind === 'recipe' ? l.itemId : null,
      itemMenuId: l.itemKind === 'menu' ? l.itemId : null,
      itemIngredientId: l.itemKind === 'ingredient' ? l.itemId : null,
      quantity: l.quantity,
      ingredientQtyCanonical:
        l.itemKind === 'ingredient' ? l.ingredientQtyCanonical : null,
      unitNetCents: l.unitNetCents,
      taxRateBps: l.taxRateBps,
    })),
  });

  const onSave = (after?: () => void) => {
    if (lines.length === 0) {
      setError(t('errors.noLines'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result =
        mode === 'create'
          ? await createSaleAction(buildPayload())
          : await updateSaleAction(saleId as string, {
              expectedUpdatedAt: expectedUpdatedAt as string,
              ...buildPayload(),
            });
      if (result.ok) {
        if (mode === 'create') router.push(`/sales/${result.data.id}`);
        else {
          setSaved(true);
          router.refresh();
          after?.();
        }
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const onPost = () => {
    setError(null);
    startTransition(async () => {
      const result = await postSaleAction(saleId as string, {
        expectedUpdatedAt: expectedUpdatedAt as string,
      });
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  };

  const confirmDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteSaleAction(saleId as string, {
        expectedUpdatedAt: expectedUpdatedAt as string,
      });
      if (result.ok) router.push('/sales');
      else {
        setError(actionError(result.code));
        setConfirmOpen(false);
      }
    });
  };

  const newOptions = optionsFor(newKind);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/sales"
          className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label={t('actions.back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <label className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t('fields.saleDate')}</span>
          <Input
            type="date"
            className="h-11 w-44"
            value={saleDate}
            disabled={pending}
            onChange={(e) => {
              setSaleDate(e.target.value);
              dirty();
            }}
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          {saved && (
            <span className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
              <CheckCircle2 className="size-4" />
              {t('saved')}
            </span>
          )}
          <Button type="button" onClick={() => onSave()} disabled={pending}>
            {mode === 'create' ? t('actions.create') : t('actions.save')}
          </Button>
          {mode === 'edit' && (
            <>
              <Button type="button" onClick={onPost} disabled={pending || lines.length === 0}>
                {t('actions.post')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmOpen(true)}
                disabled={pending}
                aria-label={t('actions.delete')}
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {defaultTaxRateBps === null && (
        <p
          role="status"
          className="inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
        >
          <AlertTriangle className="size-4 shrink-0" />
          {t('taxRateMissing')}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Lines */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('lines.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2">{t('lines.item')}</th>
                    <th className="pb-2">{t('lines.units')}</th>
                    <th className="pb-2">{t('lines.unitNet')}</th>
                    <th className="pb-2">{t('lines.taxRate')}</th>
                    <th className="pb-2 text-right">{t('lines.gross')}</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                        {t('lines.empty')}
                      </td>
                    </tr>
                  )}
                  {lines.map((line) => {
                    const money = saleLineTotals({
                      netCents: line.quantity * line.unitNetCents,
                      bps: line.taxRateBps,
                    });
                    return (
                      <tr key={line.key} className="border-b border-border last:border-0 align-top">
                        <td className="py-2 pr-2">
                          <span className="font-medium text-foreground">{line.itemName}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t(`itemKind.${line.itemKind}`)}
                          </span>
                          {!line.available && (
                            <Badge variant="warning" className="ml-2">
                              {t('unavailableLine')}
                            </Badge>
                          )}
                          {line.itemKind === 'ingredient' && (
                            <label className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                              {t('lines.perUnit')}
                              <Input
                                type="number"
                                min={0}
                                step="0.01"
                                inputMode="decimal"
                                className="h-8 w-24"
                                value={String(line.ingredientQtyCanonical ?? 0)}
                                disabled={pending}
                                onChange={(e) =>
                                  patchLine(line.key, {
                                    ingredientQtyCanonical: Math.max(0, Number(e.target.value) || 0),
                                  })
                                }
                              />
                            </label>
                          )}
                        </td>
                        <td className="py-2 pr-2">
                          <Input
                            aria-label={t('lines.units')}
                            type="number"
                            min={1}
                            max={100000}
                            inputMode="numeric"
                            className="w-20"
                            value={String(line.quantity)}
                            disabled={pending}
                            onChange={(e) =>
                              patchLine(line.key, {
                                quantity: Math.min(100000, Math.max(1, Math.round(Number(e.target.value) || 1))),
                              })
                            }
                          />
                        </td>
                        <td className="py-2 pr-2">
                          <Input
                            aria-label={t('lines.unitNet')}
                            inputMode="decimal"
                            className="w-28"
                            defaultValue={centsToAmountInput(line.unitNetCents)}
                            disabled={pending}
                            onBlur={(e) =>
                              patchLine(line.key, { unitNetCents: parseMoneyToCents(e.target.value) })
                            }
                          />
                        </td>
                        <td className="py-2 pr-2">
                          <Input
                            aria-label={t('lines.taxRate')}
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            inputMode="decimal"
                            className="w-20"
                            value={String(bpsToPercent(line.taxRateBps))}
                            disabled={pending}
                            onChange={(e) =>
                              patchLine(line.key, { taxRateBps: percentToBps(Number(e.target.value) || 0) })
                            }
                          />
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatMoney(money.grossCents, currency)}
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={t('lines.remove')}
                            disabled={pending}
                            onClick={() => removeLine(line.key)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Add line */}
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[auto_1fr_auto] sm:items-center">
              <Select
                aria-label={t('lines.kind')}
                value={newKind}
                disabled={pending}
                onChange={(e) => {
                  setNewKind(e.target.value as SaleItemKind);
                  setNewItemId('');
                }}
              >
                <option value="recipe">{t('itemKind.recipe')}</option>
                <option value="menu">{t('itemKind.menu')}</option>
                <option value="ingredient">{t('itemKind.ingredient')}</option>
              </Select>
              <Select
                aria-label={t('lines.item')}
                value={newItemId}
                disabled={pending || newOptions.length === 0}
                onChange={(e) => setNewItemId(e.target.value)}
              >
                <option value="">
                  {newOptions.length === 0 ? t('lines.noOptions') : t('lines.select')}
                </option>
                {newOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
              <Button type="button" onClick={addLine} disabled={pending || newItemId === ''}>
                <Plus className="size-4" />
                {t('lines.add')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Totals + note */}
        <Card>
          <CardHeader>
            <CardTitle>{t('totals.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <dl className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t('totals.net')}</dt>
                <dd className="tabular-nums">{formatMoney(totals.netCents, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t('totals.tax')}</dt>
                <dd className="tabular-nums">{formatMoney(totals.taxCents, currency)}</dd>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-1.5 font-medium">
                <dt>{t('totals.gross')}</dt>
                <dd className="tabular-nums">{formatMoney(totals.grossCents, currency)}</dd>
              </div>
            </dl>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">{t('fields.note')}</span>
              <Textarea
                value={note}
                disabled={pending}
                placeholder={t('placeholders.note')}
                onChange={(e) => {
                  setNote(e.target.value);
                  dirty();
                }}
              />
            </label>
            <p className="text-xs text-muted-foreground">{t('totals.previewHint')}</p>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { date: initial.saleDate })}
        confirmLabel={tCommon('delete')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
