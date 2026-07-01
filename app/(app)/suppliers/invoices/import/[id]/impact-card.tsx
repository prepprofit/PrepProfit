'use client';

import { useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, Check, TrendingDown, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/format/money';
import { useActionError } from '@/lib/i18n/use-action-error';
import { cn } from '@/lib/utils';
import type { ActionErrorCode } from '@/lib/action-result';
import type {
  AffectedMenuImpact,
  ProjectedCostImpact,
} from '@/lib/calculations/cost-impact';
import { acceptImportPendingCostAction } from '@/app/(app)/suppliers/invoices/actions';

/**
 * Invoice-to-Profit Impact card (Sprint 3). Manager-only (the page is gated).
 * Shows what accepting the invoice's PENDING cost observations would do to
 * recipe/menu margins — everything is labelled projected/pending and NOTHING is
 * written until the manager accepts a cost with the reuse of the existing
 * pending-cost acceptance flow. Purely reads the `ProjectedCostImpact` DTO the
 * page resolved (deterministic; no AI, no money math here).
 */
export function InvoiceImpactCard({
  importId,
  currency,
  impact,
}: {
  importId: string;
  currency: string;
  impact: ProjectedCostImpact;
}) {
  const t = useTranslations('suppliers.invoices.impact');
  const locale = useLocale();
  const actionError = useActionError();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [error, setError] = useState<ActionErrorCode | null>(null);

  const money = (cents: number) => formatMoney(cents, currency, locale);
  const pct = (value: number | null) => (value == null ? t('marginNa') : `${value}%`);

  function accept(ingredientId: string) {
    setError(null);
    setAcceptingId(ingredientId);
    startTransition(async () => {
      const res = await acceptImportPendingCostAction(importId, ingredientId);
      setAcceptingId(null);
      if (res.ok) router.refresh();
      else setError(res.code);
    });
  }

  const { summary, changes, affectedRecipes, affectedMenus } = impact;
  const target = affectedRecipes[0]?.targetMarginPercent ?? affectedMenus[0]?.targetMarginPercent ?? 65;

  if (changes.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('empty')}</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
        <span className="text-foreground">
          {t('summary.ingredients', { count: summary.ingredientsChangedCount })}
        </span>
        <span className="text-muted-foreground">
          {t('summary.recipes', { count: summary.recipesAffectedCount })}
        </span>
        <span className="text-muted-foreground">
          {t('summary.menus', { count: summary.menusAffectedCount })}
        </span>
        {summary.recipesBelowTargetCount + summary.menusBelowTargetCount > 0 && (
          <span className="text-amber-700 dark:text-amber-300">
            {t('summary.belowTarget', {
              count: summary.recipesBelowTargetCount + summary.menusBelowTargetCount,
              target,
            })}
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-400/60 bg-red-50/50 p-2.5 text-sm text-red-700 dark:bg-red-500/5 dark:text-red-300">
          {actionError(error)}
        </p>
      )}

      {/* Cost changes */}
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('changesHeading')}
        </h3>
        <div className="divide-y divide-border">
          {changes.map((change) => {
            const up = change.percentChange == null || change.percentChange >= 0;
            return (
              <div
                key={change.ingredientId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0"
              >
                <Link
                  href="/ingredients"
                  className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:underline"
                >
                  {change.ingredientName}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {money(change.currentCostCents)} → {money(change.projectedCostCents)}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-xs font-medium',
                    up
                      ? 'text-red-700 dark:text-red-300'
                      : 'text-emerald-700 dark:text-emerald-300',
                  )}
                >
                  {up ? (
                    <TrendingUp className="size-3.5" aria-hidden />
                  ) : (
                    <TrendingDown className="size-3.5" aria-hidden />
                  )}
                  {change.percentChange == null
                    ? t('newlyPriced')
                    : `${change.percentChange > 0 ? '+' : ''}${change.percentChange}%`}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => accept(change.ingredientId)}
                >
                  <Check className="size-3.5" />
                  {acceptingId === change.ingredientId ? t('accepting') : t('accept')}
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {affectedRecipes.length > 0 && (
        <ImpactGroup
          heading={t('recipesHeading')}
          rows={affectedRecipes.map((r) => ({
            id: r.recipeId,
            name: r.recipeName,
            href: `/recipes/${r.recipeId}`,
            current: r.currentMarginPercent,
            projected: r.projectedMarginPercent,
            belowTarget: r.belowTarget,
            crosses: r.crossesBelowTarget,
            suggested: r.suggestedPriceCents,
          }))}
          money={money}
          pct={pct}
          t={t}
          target={target}
        />
      )}

      {affectedMenus.length > 0 && (
        <ImpactGroup
          heading={t('menusHeading')}
          rows={affectedMenus.map((m: AffectedMenuImpact) => ({
            id: m.menuId,
            name: m.menuName,
            href: `/menus/${m.menuId}`,
            current: m.currentMarginPercent,
            projected: m.projectedMarginPercent,
            belowTarget: m.belowTarget,
            crosses: m.crossesBelowTarget,
            suggested: m.suggestedPriceCents,
          }))}
          money={money}
          pct={pct}
          t={t}
          target={target}
        />
      )}
    </section>
  );
}

type ImpactGroupRow = {
  id: string;
  name: string;
  href: string;
  current: number | null;
  projected: number | null;
  belowTarget: boolean;
  crosses: boolean;
  suggested: number | null;
};

/** One affected-entity group (recipes or menus). Reused so both look identical. */
function ImpactGroup({
  heading,
  rows,
  money,
  pct,
  t,
  target,
}: {
  heading: string;
  rows: ImpactGroupRow[];
  money: (cents: number) => string;
  pct: (value: number | null) => string;
  t: ReturnType<typeof useTranslations>;
  target: number;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <div className="divide-y divide-border">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0"
          >
            <Link
              href={row.href}
              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:underline"
            >
              {row.name}
            </Link>
            <span className="text-sm text-muted-foreground">
              {pct(row.current)} → <span className="text-foreground">{pct(row.projected)}</span>{' '}
              <span className="text-xs">({t('projected')})</span>
            </span>
            {row.crosses ? (
              <Badge tone="critical">{t('crossesBadge')}</Badge>
            ) : row.belowTarget ? (
              <Badge tone="warning">{t('belowBadge', { target })}</Badge>
            ) : null}
            {row.suggested != null && row.belowTarget && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <ArrowRight className="size-3" aria-hidden />
                {t('suggested', { amount: money(row.suggested) })}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: 'critical' | 'warning';
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'critical'
          ? 'bg-red-500/10 text-red-700 dark:text-red-300'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
      )}
    >
      {children}
    </span>
  );
}
