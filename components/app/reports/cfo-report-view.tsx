'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  ArrowRight,
  Percent,
  Truck,
  PackageSearch,
  Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/format/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { leakHref, leakLabel } from '@/lib/profit-leaks/labels';
import type { CfoReport, CfoTrendDirection } from '@/lib/calculations/cfo-report';
import type { Dimension } from '@/lib/units';

/**
 * Weekly CFO Report — deterministic view (Sprint 8, Slice 8.5). Presentational: the page
 * resolves the report (loadCfoReport, manager-gated) and passes the plain result; this renders
 * the revenue + food-cost trends, the biggest margin leaks, reprice candidates, supplier price
 * changes, low stock, and the explicit confidence notes. Money always goes through
 * {@link formatMoney}; a null trend is shown as "—", never a fabricated figure. The optional AI
 * write-up is a separate metered card.
 */

const UNIT_LABEL: Record<Dimension, string> = {
  weight: 'g',
  volume: 'ml',
  count: 'pcs',
};

/** For revenue UP is good; the caller passes `goodDirection` so tone flips for food cost. */
function TrendPill({
  direction,
  value,
  goodDirection,
}: {
  direction: CfoTrendDirection;
  value: string;
  goodDirection: 'up' | 'down';
}) {
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;
  const good = direction === goodDirection;
  const tone =
    direction === 'flat'
      ? 'bg-muted text-muted-foreground'
      : good
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
        : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
        tone,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {value}
    </span>
  );
}

export function CfoReportView({
  report,
  currency,
}: {
  report: CfoReport;
  currency: string;
}) {
  const t = useTranslations('cfoReport');
  const tLeak = useTranslations('dashboard.profitLeaks');

  const fmtQty = (canonical: number, dimension: Dimension) =>
    `${Math.round(canonical).toLocaleString()} ${UNIT_LABEL[dimension]}`;

  if (!report.hasData) {
    return (
      <Card>
        <CardContent className="py-12">
          <p className="text-center text-sm text-muted-foreground">{t('empty')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ── Trends ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2 text-base">
              <TrendingUp className="size-4" aria-hidden />
              {t('revenue.title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold tabular-nums text-foreground">
                {formatMoney(report.revenue.thisWeekGrossCents, currency)}
              </span>
              <TrendPill
                direction={report.revenue.direction}
                goodDirection="up"
                value={
                  report.revenue.changePercent == null
                    ? '—'
                    : `${report.revenue.changePercent > 0 ? '+' : ''}${report.revenue.changePercent}%`
                }
              />
            </div>
            <p className="text-muted-foreground">
              {t('revenue.priorWeek', {
                amount: formatMoney(report.revenue.priorWeekGrossCents, currency),
              })}
            </p>
            <p className="text-xs text-muted-foreground/80">
              {t('revenue.net', {
                amount: formatMoney(report.revenue.thisWeekNetCents, currency),
              })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2 text-base">
              <Percent className="size-4" aria-hidden />
              {t('foodCost.title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold tabular-nums text-foreground">
                {report.foodCost.thisWeekPercent == null
                  ? '—'
                  : `${report.foodCost.thisWeekPercent}%`}
              </span>
              {/* Rising food-cost % is bad → good direction is "down". */}
              <TrendPill
                direction={report.foodCost.direction}
                goodDirection="down"
                value={
                  report.foodCost.changePoints == null
                    ? '—'
                    : `${report.foodCost.changePoints > 0 ? '+' : ''}${report.foodCost.changePoints} pts`
                }
              />
            </div>
            <p className="text-muted-foreground">
              {report.foodCost.priorWeekPercent == null
                ? t('foodCost.noPrior')
                : t('foodCost.priorWeek', { percent: report.foodCost.priorWeekPercent })}
            </p>
            {!report.foodCost.thisWeekComplete && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{t('foodCost.partial')}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Margin leaks ────────────────────────────────────────────────── */}
      {report.marginLeaks.length > 0 && (
        <SectionCard title={t('leaks.title')}>
          <ul className="flex flex-col divide-y divide-border">
            {report.marginLeaks.map((finding) => (
              <li
                key={finding.fingerprint}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="text-foreground">
                  {leakLabel(finding, report.targetMarginPercent, tLeak)}
                </span>
                <Link
                  href={leakHref(finding)}
                  className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-700 hover:underline dark:text-accent-300"
                >
                  {t('open')}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* ── Reprice candidates ──────────────────────────────────────────── */}
      {report.repriceCandidates.length > 0 && (
        <SectionCard title={t('reprice.title')}>
          <ul className="flex flex-col divide-y divide-border">
            {report.repriceCandidates.map((c) => (
              <li
                key={`${c.entityType}-${c.entityId}`}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="text-foreground">{c.entityName}</span>
                <span className="flex items-center gap-3 tabular-nums">
                  <span className="text-red-600 dark:text-red-400">
                    {t('reprice.margin', { margin: c.currentMarginPercent })}
                  </span>
                  {c.suggestedPriceCents != null && (
                    <span className="text-muted-foreground">
                      {t('reprice.suggested', {
                        price: formatMoney(c.suggestedPriceCents, currency),
                      })}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* ── Supplier price changes ──────────────────────────────────────── */}
      {report.supplierPriceChanges.length > 0 && (
        <SectionCard title={t('supplierChanges.title')} icon={Truck}>
          <ul className="flex flex-col divide-y divide-border">
            {report.supplierPriceChanges.map((c) => (
              <li
                key={c.ingredientId}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="text-foreground">{c.name}</span>
                <span className="flex items-center gap-2 tabular-nums text-muted-foreground">
                  {formatMoney(c.fromCents, currency)}
                  <ArrowRight className="size-3.5" aria-hidden />
                  {formatMoney(c.toCents, currency)}
                  <TrendPill
                    direction={c.direction}
                    goodDirection="down"
                    value={
                      c.changePercent == null
                        ? '—'
                        : `${c.changePercent > 0 ? '+' : ''}${c.changePercent}%`
                    }
                  />
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* ── Low stock ───────────────────────────────────────────────────── */}
      {report.lowStock.length > 0 && (
        <SectionCard title={t('lowStock.title')} icon={PackageSearch}>
          <ul className="flex flex-col divide-y divide-border">
            {report.lowStock.map((l) => (
              <li
                key={l.ingredientId}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="text-foreground">{l.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {t('lowStock.onHand', {
                    onHand: fmtQty(l.onHandCanonical, l.dimension),
                    threshold: fmtQty(l.thresholdCanonical, l.dimension),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* ── Confidence notes ────────────────────────────────────────────── */}
      {report.confidence.length > 0 && (
        <SectionCard title={t('confidence.title')} icon={Info}>
          <ul className="flex flex-col gap-1.5">
            {report.confidence.map((note) => (
              <li key={note.code} className="flex gap-2 text-sm text-muted-foreground">
                <span aria-hidden className="text-amber-600 dark:text-amber-400">
                  •
                </span>
                <span>{t(`confidence.code.${note.code}`, { count: note.count })}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}

function SectionCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2 text-base">
          {Icon && <Icon className="size-4" aria-hidden />}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
