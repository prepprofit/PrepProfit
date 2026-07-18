'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  centsToAmountInput,
  formatMoney,
  parseMoneyToCents,
} from '@/lib/format/money';
import {
  foodCostBps,
  portionOptionCostCents,
  profitCents,
  suggestedPriceCents,
} from '@/lib/calculations/foodCost';
import {
  createPortionOptionAction,
  deletePortionOptionAction,
  setDefaultPortionOptionAction,
  setNutritionServingPortionOptionAction,
  updatePortionOptionAction,
} from '@/app/(app)/recipes/[id]/portion-actions';
import type { ActionResult } from '@/lib/action-result';
import type { PortionCostView } from './recipe-workspace-tabs';

/**
 * Manager-only portion-option management + bidirectional food-cost calculator
 * (Recipes 2.0 Fase 5b, plan §7.3). Rendered ONLY inside the complete-cost
 * branch of the Cost tab — the kitchen payload ships `cost: null`, so this
 * component (and every price in it) never reaches a kitchen client.
 *
 * ONE calculator direction is active per interaction: the LAST edited field
 * (price or target) decides which pure function runs — the form never feeds
 * itself into a loop. All math lives in `lib/calculations/foodCost`; nothing
 * is duplicated here.
 */

/** Yield context the client needs to price a draft portion live. */
export type PortionYieldContext = {
  totalCostCents: number;
  yieldQuantity: number | null;
  yieldUnit: string | null;
  yieldPortions: number;
};

type DraftForm = {
  name: string;
  quantityText: string;
  unit: string;
  priceText: string;
  /** Target food cost as a PERCENT string ("30" = 3000 bps). */
  targetText: string;
  lastEdited: 'price' | 'target' | null;
};

function formToDraft(option: PortionCostView | null): DraftForm {
  return {
    name: option?.name ?? '',
    quantityText: option ? String(option.quantity) : '1',
    unit: option?.unit ?? 'serving',
    priceText:
      option?.sellingPriceCents != null
        ? centsToAmountInput(option.sellingPriceCents)
        : '',
    targetText:
      option?.targetFoodCostBps != null
        ? formatBpsAsPercentInput(option.targetFoodCostBps)
        : '',
    lastEdited: null,
  };
}

/** "3000" bps → "30"; keeps fractional targets ("2550" → "25.5"). */
function formatBpsAsPercentInput(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/0+$/, '');
}

/** Percent text ("30" / "27,5") → bps 1..10000, null when empty/invalid. */
function parsePercentToBps(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const pct = Number(trimmed);
  if (!Number.isFinite(pct)) return null;
  const bps = Math.round(pct * 100);
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

function parseQuantity(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Empty price text = no price (null), never a free 0. */
function parsePrice(text: string): number | null {
  return text.trim() === '' ? null : parseMoneyToCents(text);
}

function formatBpsAsPercent(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

export function PortionOptionsSection({
  recipeId,
  portions,
  yieldContext,
  currency,
}: {
  recipeId: string;
  portions: PortionCostView[];
  yieldContext: PortionYieldContext;
  currency: string;
}) {
  const t = useTranslations('recipes.workspace.cost.portionEditor');
  const tCost = useTranslations('recipes.workspace.cost');
  const actionError = useActionError();
  const router = useRouter();

  // 'new' | option key | null — one open form at a time.
  const [editingKey, setEditingKey] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<DraftForm>(formToDraft(null));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = React.useState<string | null>(
    null,
  );

  const openForm = (option: PortionCostView | null) => {
    setForm(formToDraft(option));
    setEditingKey(option?.key ?? 'new');
    setError(null);
    setConfirmDeleteKey(null);
  };

  const closeForm = () => {
    setEditingKey(null);
    setError(null);
  };

  const runAction = async (action: () => Promise<ActionResult<unknown>>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      closeForm();
      setConfirmDeleteKey(null);
      router.refresh();
    } else {
      setError(actionError(result.code));
    }
  };

  const save = () => {
    const quantity = parseQuantity(form.quantityText);
    const name = form.name.trim();
    const unit = form.unit.trim();
    if (!name || !unit || quantity === null) {
      setError(t('invalidForm'));
      return;
    }
    const payload = {
      name,
      quantity,
      unit,
      sellingPriceCents: parsePrice(form.priceText),
      targetFoodCostBps: parsePercentToBps(form.targetText),
    };
    void runAction(() =>
      editingKey === 'new'
        ? createPortionOptionAction({ recipeId, ...payload })
        : updatePortionOptionAction({ optionId: editingKey!, ...payload }),
    );
  };

  // ── live calculator for the open form (pure module, client-side) ────────
  const draftQuantity = parseQuantity(form.quantityText);
  const draftCostCents = portionOptionCostCents({
    totalCostCents: yieldContext.totalCostCents,
    portionQuantity: draftQuantity,
    portionUnit: form.unit,
    yieldQuantity: yieldContext.yieldQuantity,
    yieldUnit: yieldContext.yieldUnit,
    yieldPortions: yieldContext.yieldPortions,
  });
  const draftPriceCents = parsePrice(form.priceText);
  const draftTargetBps = parsePercentToBps(form.targetText);
  const liveFoodCostBps = foodCostBps(draftCostCents, draftPriceCents);
  const liveProfitCents = profitCents(draftCostCents, draftPriceCents);
  const liveSuggestedCents = suggestedPriceCents(draftCostCents, draftTargetBps);

  const renderForm = () => (
    <div className="flex flex-col gap-3 border-t border-border bg-surface-2/50 px-4 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('name')}
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="h-8 w-40"
            placeholder={t('namePlaceholder')}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('quantity')}
          <Input
            value={form.quantityText}
            onChange={(e) => setForm({ ...form, quantityText: e.target.value })}
            inputMode="decimal"
            className="h-8 w-20"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('unit')}
          <Input
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
            className="h-8 w-28"
            placeholder={t('unitPlaceholder')}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {`${t('sellingPrice')} · ${currency}`}
          <Input
            value={form.priceText}
            onChange={(e) =>
              setForm({ ...form, priceText: e.target.value, lastEdited: 'price' })
            }
            inputMode="decimal"
            className="h-8 w-24"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('targetFoodCost')}
          <Input
            value={form.targetText}
            onChange={(e) =>
              setForm({
                ...form,
                targetText: e.target.value,
                lastEdited: 'target',
              })
            }
            inputMode="decimal"
            className="h-8 w-20"
          />
        </label>
      </div>

      {/* One direction per interaction: the last edited field decides. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t('portionCost')}:{' '}
          <span className="font-medium tabular-nums text-foreground">
            {draftCostCents !== null ? formatMoney(draftCostCents, currency) : '—'}
          </span>
        </span>
        {form.lastEdited !== 'target' ? (
          <>
            <span>
              {t('foodCost')}:{' '}
              <span className="font-medium tabular-nums text-foreground">
                {liveFoodCostBps !== null
                  ? formatBpsAsPercent(liveFoodCostBps)
                  : '—'}
              </span>
            </span>
            <span>
              {t('profit')}:{' '}
              <span className="font-medium tabular-nums text-foreground">
                {liveProfitCents !== null
                  ? formatMoney(liveProfitCents, currency)
                  : '—'}
              </span>
            </span>
          </>
        ) : (
          <span className="flex items-center gap-2">
            {t('suggestedPrice')}:{' '}
            <span className="font-medium tabular-nums text-foreground">
              {liveSuggestedCents !== null
                ? formatMoney(liveSuggestedCents, currency)
                : '—'}
            </span>
            {liveSuggestedCents !== null ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() =>
                  setForm({
                    ...form,
                    priceText: centsToAmountInput(liveSuggestedCents),
                    lastEdited: 'price',
                  })
                }
              >
                {t('applySuggested')}
              </Button>
            ) : null}
          </span>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={save} disabled={busy}>
          {busy ? t('saving') : t('save')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={closeForm}
          disabled={busy}
        >
          {t('cancel')}
        </Button>
      </div>
    </div>
  );

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {tCost('portions')}
        </h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => openForm(null)}
          disabled={busy || editingKey !== null}
        >
          {t('add')}
        </Button>
      </div>
      {error && editingKey === null ? (
        <p role="alert" className="mb-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {portions.map((p) => {
          const rowFoodCostBps = foodCostBps(p.costCents, p.sellingPriceCents);
          return (
            <li key={p.key}>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 truncate">
                  {p.name}
                  {p.isDefault ? (
                    <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">
                      {tCost('defaultPortion')}
                    </span>
                  ) : null}
                  {p.isNutritionServing ? (
                    <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">
                      {t('nutritionServing')}
                    </span>
                  ) : null}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {p.quantityLabel}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {p.sellingPriceCents !== null
                      ? formatMoney(p.sellingPriceCents, currency)
                      : '—'}
                    {rowFoodCostBps !== null
                      ? ` · ${formatBpsAsPercent(rowFoodCostBps)}`
                      : ''}
                  </span>
                  <span className="font-medium tabular-nums">
                    {p.costCents !== null
                      ? formatMoney(p.costCents, currency)
                      : '—'}
                  </span>
                </span>
              </div>
              <div className="flex flex-wrap gap-1 px-4 pb-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => openForm(p)}
                  disabled={busy}
                >
                  {t('edit')}
                </Button>
                {!p.isDefault ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      void runAction(() =>
                        setDefaultPortionOptionAction({ optionId: p.key }),
                      )
                    }
                    disabled={busy}
                  >
                    {t('makeDefault')}
                  </Button>
                ) : null}
                {!p.isNutritionServing ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      void runAction(() =>
                        setNutritionServingPortionOptionAction({
                          optionId: p.key,
                        }),
                      )
                    }
                    disabled={busy}
                  >
                    {t('makeNutritionServing')}
                  </Button>
                ) : null}
                {confirmDeleteKey === p.key ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs text-red-700 dark:text-red-300"
                    onClick={() =>
                      void runAction(() =>
                        deletePortionOptionAction({ optionId: p.key }),
                      )
                    }
                    disabled={busy}
                  >
                    {t('confirmDelete')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => setConfirmDeleteKey(p.key)}
                    disabled={busy}
                  >
                    {t('delete')}
                  </Button>
                )}
              </div>
              {editingKey === p.key ? renderForm() : null}
            </li>
          );
        })}
        {editingKey === 'new' ? <li>{renderForm()}</li> : null}
        {portions.length === 0 && editingKey === null ? (
          <li className="px-4 py-2.5 text-sm text-muted-foreground">
            {t('empty')}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
