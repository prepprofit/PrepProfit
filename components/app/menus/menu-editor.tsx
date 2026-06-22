'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, Check, Plus, Trash2 } from 'lucide-react';
import type { MenuRecipeOption } from '@/lib/data/menus';
import {
  foodCostPercent,
  menuCost,
  type MenuCostLine,
} from '@/lib/calculations/menu';
import {
  marginPercent,
  trafficLight,
  type MarginLight,
} from '@/lib/calculations/margin';
import {
  centsToAmountInput,
  formatMoney,
  parseMoneyToCents,
} from '@/lib/format/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  createMenuAction,
  deleteMenuAction,
  updateMenuAction,
} from '@/app/(app)/menus/actions';
import { useActionError } from '@/lib/i18n/use-action-error';

const LIGHT_VARIANT: Record<MarginLight, 'positive' | 'warning' | 'negative'> = {
  green: 'positive',
  yellow: 'warning',
  red: 'negative',
};

/** A line as the editor holds it — recipe identity + the per-portion cost it costs at. */
export type EditorMenuLine = {
  recipeId: string;
  recipeName: string;
  quantity: number;
  available: boolean;
  /** null when the recipe is unavailable (trashed/missing). */
  costPerPortionCents: number | null;
};

export type MenuEditorInitial = {
  name: string;
  sellingPriceCents: number | null;
  notes: string | null;
  lines: EditorMenuLine[];
};

export function MenuEditor({
  mode,
  menuId,
  initial,
  recipeOptions,
  currency,
}: {
  mode: 'create' | 'edit';
  menuId?: string;
  initial: MenuEditorInitial;
  recipeOptions: MenuRecipeOption[];
  currency: string;
}) {
  const t = useTranslations('menus');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [name, setName] = React.useState(initial.name);
  const [sellingText, setSellingText] = React.useState(
    initial.sellingPriceCents != null ? centsToAmountInput(initial.sellingPriceCents) : '',
  );
  const [notes, setNotes] = React.useState(initial.notes ?? '');
  const [lines, setLines] = React.useState<EditorMenuLine[]>(initial.lines);
  const [newRecipeId, setNewRecipeId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // Recipes not already on the menu — the picker's options.
  const availableOptions = recipeOptions.filter(
    (o) => !lines.some((l) => l.recipeId === o.id),
  );

  // --- live cost & KPIs (mirror the server's derived values) ---
  const costLines: MenuCostLine[] = lines.map((l) => ({
    recipeId: l.recipeId,
    quantity: l.quantity,
    costPerPortionCents: l.costPerPortionCents,
  }));
  const cost = menuCost(costLines);
  const priceCents =
    sellingText.trim() === '' ? null : parseMoneyToCents(sellingText);
  const effectivePrice = priceCents != null && priceCents > 0 ? priceCents : null;
  const costCents = cost.complete ? cost.costCents : null;
  const foodCost = foodCostPercent(costCents, effectivePrice);
  const margin =
    cost.complete && effectivePrice != null
      ? marginPercent(cost.costCents, effectivePrice)
      : null;
  const light = margin != null ? trafficLight(margin) : null;

  const dash = '—';

  const addLine = () => {
    const opt = recipeOptions.find((o) => o.id === newRecipeId);
    if (!opt) return;
    setLines((prev) => [
      ...prev,
      {
        recipeId: opt.id,
        recipeName: opt.name,
        quantity: 1,
        available: true,
        costPerPortionCents: opt.costPerPortionCents,
      },
    ]);
    setNewRecipeId('');
    setSaved(false);
  };

  const setLineQuantity = (recipeId: string, value: string) => {
    const n = Math.round(Number(value) || 0);
    setLines((prev) =>
      prev.map((l) =>
        l.recipeId === recipeId
          ? { ...l, quantity: Math.min(1000, Math.max(1, n || 1)) }
          : l,
      ),
    );
    setSaved(false);
  };

  const removeLine = (recipeId: string) => {
    setLines((prev) => prev.filter((l) => l.recipeId !== recipeId));
    setSaved(false);
  };

  const onSave = () => {
    if (name.trim() === '') {
      setError(t('errors.nameRequired'));
      return;
    }
    if (lines.length === 0) {
      setError(t('errors.noItems'));
      return;
    }
    setError(null);
    const payload = {
      name: name.trim(),
      sellingPriceCents:
        sellingText.trim() === '' ? null : parseMoneyToCents(sellingText),
      notes: notes.trim() === '' ? null : notes.trim(),
      items: lines.map((l) => ({ recipeId: l.recipeId, quantity: l.quantity })),
    };
    startTransition(async () => {
      const result =
        mode === 'create'
          ? await createMenuAction(payload)
          : await updateMenuAction(menuId as string, payload);
      if (result.ok) {
        if (mode === 'create') {
          router.push(`/menus/${result.data.id}`);
        } else {
          setSaved(true);
          router.refresh();
        }
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const confirmDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteMenuAction(menuId as string);
      if (result.ok) router.push('/menus');
      else {
        setError(actionError(result.code));
        setConfirmOpen(false);
      }
    });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/menus"
          className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label={t('actions.back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <Input
          aria-label={t('fields.name')}
          placeholder={t('fields.namePlaceholder')}
          className="h-11 max-w-md flex-1 text-lg font-medium"
          value={name}
          disabled={pending}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
        <div className="ml-auto flex items-center gap-2">
          {saved && (
            <span className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
              <Check className="size-4" />
              {t('saved')}
            </span>
          )}
          <Button type="button" onClick={onSave} disabled={pending}>
            {mode === 'create' ? t('actions.create') : t('actions.save')}
          </Button>
          {mode === 'edit' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(true)}
              disabled={pending}
              aria-label={t('actions.delete')}
            >
              <Trash2 className="size-4" />
            </Button>
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

      {!cost.complete && lines.length > 0 && (
        <p
          role="status"
          className="inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
        >
          <AlertTriangle className="size-4 shrink-0" />
          {t('incomplete.managerBody')}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Components */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('composition.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2">{t('composition.recipe')}</th>
                    <th className="pb-2">{t('composition.quantity')}</th>
                    <th className="pb-2 text-right">{t('composition.lineCost')}</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td
                        colSpan={4}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        {t('composition.empty')}
                      </td>
                    </tr>
                  )}
                  {lines.map((line) => (
                    <tr
                      key={line.recipeId}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-2 pr-2">
                        <span className="font-medium text-foreground">
                          {line.recipeName}
                        </span>
                        {!line.available && (
                          <Badge variant="warning" className="ml-2">
                            {t('unavailableLine')}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        <Input
                          aria-label={t('composition.quantity')}
                          type="number"
                          min={1}
                          max={1000}
                          inputMode="numeric"
                          className="w-20"
                          value={String(line.quantity)}
                          disabled={pending}
                          onChange={(e) =>
                            setLineQuantity(line.recipeId, e.target.value)
                          }
                        />
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">
                        {line.costPerPortionCents != null
                          ? formatMoney(
                              line.costPerPortionCents * line.quantity,
                              currency,
                            )
                          : dash}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t('composition.remove')}
                          disabled={pending}
                          onClick={() => removeLine(line.recipeId)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add line */}
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <Select
                aria-label={t('composition.add')}
                value={newRecipeId}
                disabled={pending || availableOptions.length === 0}
                onChange={(e) => setNewRecipeId(e.target.value)}
              >
                <option value="">
                  {availableOptions.length === 0
                    ? t('composition.allAdded')
                    : t('composition.select')}
                </option>
                {availableOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                onClick={addLine}
                disabled={pending || newRecipeId === ''}
              >
                <Plus className="size-4" />
                {t('composition.add')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Pricing + KPIs */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('pricing.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">
                  {`${t('pricing.sellingPrice')} · ${currency}`}
                </span>
                <Input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={sellingText}
                  disabled={pending}
                  onChange={(e) => {
                    setSellingText(e.target.value);
                    setSaved(false);
                  }}
                />
              </label>
              <Row
                label={t('kpis.cost')}
                value={costCents != null ? formatMoney(costCents, currency) : dash}
              />
              <Row
                label={t('kpis.foodCost')}
                value={foodCost != null ? `${foodCost}%` : dash}
              />
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('kpis.margin')}</span>
                {margin != null && light ? (
                  <Badge variant={LIGHT_VARIANT[light]}>{margin}%</Badge>
                ) : (
                  <span className="tabular-nums text-muted-foreground">{dash}</span>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('fields.notes')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={notes}
                disabled={pending}
                placeholder={t('placeholders.notes')}
                onChange={(e) => {
                  setNotes(e.target.value);
                  setSaved(false);
                }}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { name: initial.name })}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}
