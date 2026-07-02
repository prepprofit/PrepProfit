'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, Sparkles, Trash2, ChefHat, PackageSearch, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  buildPrepPlanAction,
  createPrepPlanTasksAction,
  summarizePrepPlanAction,
} from '@/app/(app)/tasks/ai-prep-planner/actions';
import type { PrepReorderPlan } from '@/lib/calculations/prep-reorder-plan';
import { displayCanonical } from '@/lib/calculations/prep-reorder-plan';
import type { PrepPlanSummary } from '@/lib/ai/prep-plan-summary';
import type { Dimension } from '@/lib/units';

type Option = { id: string; name: string };

/** Canonical unit label per dimension (the plan quantities are canonical). */
const UNIT_LABEL: Record<Dimension, string> = {
  weight: 'g',
  volume: 'ml',
  count: 'pcs',
};

const RISK_TONE: Record<PrepPlanSummary['supplyRisk'], string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  low: 'bg-muted text-muted-foreground',
};

type RecipeDemand = { recipeId: string; portions: string };
type MenuDemand = { menuId: string; covers: string };

/**
 * Prep/Reorder Planner UI (Sprint 7, money-free). The user assembles expected demand
 * (recipes × portions and/or menus × covers), builds a deterministic plan, optionally asks
 * AI to write it up, and (managers only) turns the reviewed plan into anchored tasks. Every
 * quantity comes from the server; the client only formats it.
 */
export function PrepPlannerClient({
  recipes,
  menus,
  taskLists,
  canManage,
}: {
  recipes: Option[];
  menus: Option[];
  taskLists: Option[];
  canManage: boolean;
}) {
  const t = useTranslations('prepPlanner');
  const actionError = useActionError();
  const router = useRouter();

  const [recipeDemand, setRecipeDemand] = React.useState<RecipeDemand[]>([]);
  const [menuDemand, setMenuDemand] = React.useState<MenuDemand[]>([]);
  const [plan, setPlan] = React.useState<PrepReorderPlan | null>(null);
  const [summary, setSummary] = React.useState<PrepPlanSummary | null>(null);
  const [targetListId, setTargetListId] = React.useState<string>(taskLists[0]?.id ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const selection = React.useMemo(
    () => ({
      recipes: recipeDemand
        .filter((d) => d.recipeId !== '' && Number(d.portions) > 0)
        .map((d) => ({ recipeId: d.recipeId, portions: Number(d.portions) })),
      menus: menuDemand
        .filter((d) => d.menuId !== '' && Number(d.covers) > 0)
        .map((d) => ({ menuId: d.menuId, covers: Number(d.covers) })),
    }),
    [recipeDemand, menuDemand],
  );

  const hasSelection = selection.recipes.length > 0 || selection.menus.length > 0;

  const fmtQty = (canonical: number, dimension: Dimension) =>
    `${displayCanonical(canonical).toLocaleString()} ${UNIT_LABEL[dimension]}`;

  const build = () => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await buildPrepPlanAction(selection);
      if (res.ok) {
        setPlan(res.data.plan);
        setSummary(null);
      } else {
        setError(actionError(res.code));
      }
    });
  };

  const summarize = () => {
    setError(null);
    startTransition(async () => {
      const res = await summarizePrepPlanAction(selection);
      if (res.ok) setSummary(res.data.summary);
      else setError(actionError(res.code));
    });
  };

  const createTasks = () => {
    if (!plan || targetListId === '') return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await createPrepPlanTasksAction({
        listId: targetListId,
        prepRecipeIds: plan.prepSuggestions
          .filter((p) => !p.hasIssues)
          .map((p) => p.recipeId),
        reorderIngredientIds: plan.reorderSuggestions.map((r) => r.ingredientId),
      });
      if (res.ok) {
        setNotice(
          t('tasks.created', {
            created: res.data.created,
            skipped: res.data.skippedDuplicate + res.data.skippedInvalid + res.data.skippedCap,
          }),
        );
        router.refresh();
      } else {
        setError(actionError(res.code));
      }
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ── Demand builder ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t('demand.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DemandRows
            label={t('demand.recipes')}
            emptyLabel={t('demand.noRecipes')}
            addLabel={t('demand.addRecipe')}
            unitLabel={t('demand.portions')}
            options={recipes}
            rows={recipeDemand}
            onAdd={() => setRecipeDemand((r) => [...r, { recipeId: '', portions: '' }])}
            onRemove={(i) => setRecipeDemand((r) => r.filter((_, idx) => idx !== i))}
            getOptionId={(row) => row.recipeId}
            getAmount={(row) => row.portions}
            onChange={(i, optionId, amount) =>
              setRecipeDemand((r) =>
                r.map((row, idx) =>
                  idx === i ? { recipeId: optionId, portions: amount } : row,
                ),
              )
            }
          />
          {menus.length > 0 && (
            <DemandRows
              label={t('demand.menus')}
              emptyLabel={t('demand.noMenus')}
              addLabel={t('demand.addMenu')}
              unitLabel={t('demand.covers')}
              options={menus}
              rows={menuDemand}
              onAdd={() => setMenuDemand((m) => [...m, { menuId: '', covers: '' }])}
              onRemove={(i) => setMenuDemand((m) => m.filter((_, idx) => idx !== i))}
              getOptionId={(row) => row.menuId}
              getAmount={(row) => row.covers}
              onChange={(i, optionId, amount) =>
                setMenuDemand((m) =>
                  m.map((row, idx) =>
                    idx === i ? { menuId: optionId, covers: amount } : row,
                  ),
                )
              }
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={build} disabled={pending || !hasSelection}>
              {t('build')}
            </Button>
            {plan && plan.hasPlan && (
              <Button type="button" variant="outline" onClick={summarize} disabled={pending}>
                <Sparkles className="size-4" aria-hidden />
                {summary ? t('summary.refresh') : t('summary.generate')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {/* ── AI summary ─────────────────────────────────────────────────── */}
      {summary && (
        <Card>
          <CardContent className="flex flex-col gap-2 p-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-foreground">{summary.headline}</p>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                  RISK_TONE[summary.supplyRisk],
                )}
              >
                {t(`summary.risk.${summary.supplyRisk}`)}
              </span>
            </div>
            <p className="text-muted-foreground">{summary.summary}</p>
            {summary.highlights.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {summary.highlights.map((h, i) => (
                  <li key={i} className="flex gap-2 text-muted-foreground">
                    <span aria-hidden className="text-accent-600 dark:text-accent-400">
                      •
                    </span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-xs text-muted-foreground/80">{t('summary.disclaimer')}</p>
          </CardContent>
        </Card>
      )}

      {/* ── Plan results ───────────────────────────────────────────────── */}
      {plan && !plan.hasPlan && (
        <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      )}

      {plan && plan.hasPlan && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ResultCard icon={ChefHat} title={t('prep.title')}>
            <ul className="flex flex-col divide-y divide-border">
              {plan.prepSuggestions.map((p) => (
                <li key={p.recipeId} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="flex items-center gap-2 text-foreground">
                    {p.recipeName}
                    {p.hasIssues && (
                      <TriangleAlert
                        className="size-3.5 text-amber-600 dark:text-amber-400"
                        aria-label={t('prep.hasIssues')}
                      />
                    )}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {t('prep.portions', { count: p.expectedPortions })}
                  </span>
                </li>
              ))}
            </ul>
          </ResultCard>

          <ResultCard icon={PackageSearch} title={t('reorder.title')}>
            {plan.reorderSuggestions.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">{t('reorder.none')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {plan.reorderSuggestions.map((r) => (
                  <li key={r.ingredientId} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="text-foreground">{r.ingredientName}</span>
                    <span className="tabular-nums text-red-600 dark:text-red-400">
                      {t('reorder.short', { qty: fmtQty(r.shortfallCanonical, r.dimension) })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ResultCard>

          {plan.lowStockWarnings.length > 0 && (
            <ResultCard icon={TriangleAlert} title={t('lowStock.title')}>
              <ul className="flex flex-col divide-y divide-border">
                {plan.lowStockWarnings.map((w) => (
                  <li key={w.ingredientId} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="text-foreground">{w.ingredientName}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {t('lowStock.projected', {
                        projected: fmtQty(w.projectedOnHandCanonical, w.dimension),
                        threshold: fmtQty(w.thresholdCanonical, w.dimension),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </ResultCard>
          )}

          {plan.issues.length > 0 && (
            <ResultCard icon={TriangleAlert} title={t('issues.title')}>
              <ul className="flex flex-col divide-y divide-border">
                {plan.issues.map((issue, i) => (
                  <li key={`${issue.recipeId}-${issue.code}-${i}`} className="py-2 text-sm">
                    <span className="text-foreground">{issue.recipeName}</span>
                    <span className="text-muted-foreground"> — {t(`issues.code.${issue.code}`)}</span>
                  </li>
                ))}
              </ul>
            </ResultCard>
          )}
        </div>
      )}

      {/* ── Create tasks (manager-only) ────────────────────────────────── */}
      {plan && plan.hasPlan && canManage && (
        <Card>
          <CardHeader>
            <CardTitle>{t('tasks.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {taskLists.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('tasks.noLists')}</p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('tasks.targetList')}
                  </span>
                  <Select
                    value={targetListId}
                    onChange={(e) => setTargetListId(e.target.value)}
                    className="h-9 w-56"
                  >
                    {taskLists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button
                  type="button"
                  onClick={createTasks}
                  disabled={pending || targetListId === ''}
                >
                  <Plus className="size-4" aria-hidden />
                  {t('tasks.create')}
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('tasks.hint')}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** A labelled list of demand rows: an option select + an amount input + remove. */
function DemandRows<T>({
  label,
  emptyLabel,
  addLabel,
  unitLabel,
  options,
  rows,
  onAdd,
  onRemove,
  onChange,
  getOptionId,
  getAmount,
}: {
  label: string;
  emptyLabel: string;
  addLabel: string;
  unitLabel: string;
  options: Option[];
  rows: T[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, optionId: string, amount: string) => void;
  getOptionId: (row: T) => string;
  getAmount: (row: T) => string;
}) {
  const t = useTranslations('prepPlanner');
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select
              value={getOptionId(row)}
              onChange={(e) => onChange(i, e.target.value, getAmount(row))}
              className="h-9 w-56"
            >
              <option value="">—</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              value={getAmount(row)}
              onChange={(e) => onChange(i, getOptionId(row), e.target.value)}
              placeholder={unitLabel}
              className="h-9 w-28"
              aria-label={unitLabel}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('demand.remove')}
              onClick={() => onRemove(i)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))
      )}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-4" aria-hidden />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

function ResultCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2 text-base">
          <Icon className="size-4" aria-hidden />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
