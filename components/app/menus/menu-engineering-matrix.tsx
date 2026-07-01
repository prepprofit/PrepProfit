'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/format/money';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type {
  ClassifiedMenuItem,
  MenuEngineeringClass,
  MenuEngineeringItemKind,
  MenuEngineeringResult,
} from '@/lib/calculations/menu-engineering';

/**
 * Menu Engineering matrix (Sprint 5, Slice 5.3). Presentational — the page resolves
 * the classification (loadMenuEngineering, manager-gated) and passes the plain result;
 * this renders the classic 2×2 quadrant grid plus a needs-pricing list. Each item links
 * back to its recipe/menu. Money always goes through {@link formatMoney}; margin/cost
 * is only ever shown for a classified (fully-costed) item — never a fabricated figure.
 */

/** Tailwind tint per quadrant — kept subtle; the label carries the meaning. */
const QUADRANT_TONE: Record<MenuEngineeringClass, string> = {
  star: 'border-emerald-500/40 bg-emerald-500/5',
  puzzle: 'border-sky-500/40 bg-sky-500/5',
  workhorse: 'border-amber-500/40 bg-amber-500/5',
  dog: 'border-rose-500/40 bg-rose-500/5',
};

const QUADRANT_DOT: Record<MenuEngineeringClass, string> = {
  star: 'bg-emerald-500',
  puzzle: 'bg-sky-500',
  workhorse: 'bg-amber-500',
  dog: 'bg-rose-500',
};

/**
 * Textbook reading order: profitability on the vertical axis (high row on top),
 * popularity on the horizontal (high column on the left). So the grid is
 * puzzle · star / dog · workhorse.
 */
const GRID_ORDER: MenuEngineeringClass[] = ['puzzle', 'star', 'dog', 'workhorse'];

function itemHref(kind: MenuEngineeringItemKind, id: string): string {
  return kind === 'recipe' ? `/recipes/${id}` : `/menus/${id}`;
}

export function MenuEngineeringMatrix({
  result,
  currency,
}: {
  result: MenuEngineeringResult;
  currency: string;
}) {
  const t = useTranslations('menuEngineering');

  if (result.classified.length === 0 && result.needsPricing.length === 0) {
    return (
      <Card>
        <CardContent className="py-10">
          <p className="text-center text-sm text-muted-foreground">{t('empty')}</p>
        </CardContent>
      </Card>
    );
  }

  const byClass = new Map<MenuEngineeringClass, ClassifiedMenuItem[]>();
  for (const cls of GRID_ORDER) byClass.set(cls, []);
  for (const item of result.classified) byClass.get(item.class)!.push(item);

  return (
    <div className="flex flex-col gap-5">
      {result.classified.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('splitCaption', {
            units: Math.round(result.averageUnitsSold),
            amount: formatMoney(
              Math.round(result.averageContributionMarginCents),
              currency,
            ),
          })}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {GRID_ORDER.map((cls) => {
          const items = byClass.get(cls) ?? [];
          return (
            <Card key={cls} className={cn('flex flex-col border', QUADRANT_TONE[cls])}>
              <CardHeader className="pb-2">
                <div className="flex items-baseline justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span
                      className={cn('size-2 rounded-full', QUADRANT_DOT[cls])}
                      aria-hidden
                    />
                    {t(`quadrant.${cls}.title`)}
                    <span className="text-sm font-normal text-muted-foreground">
                      ({items.length})
                    </span>
                  </CardTitle>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(`quadrant.${cls}.action`)}
                </p>
              </CardHeader>
              <CardContent className="flex-1">
                {items.length === 0 ? (
                  <p className="text-sm text-muted-foreground/70">
                    {t('quadrantEmpty')}
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {items.map((item) => (
                      <li key={`${item.kind}:${item.id}`}>
                        <Link
                          href={itemHref(item.kind, item.id)}
                          className="group flex items-center gap-2 py-2 first:pt-0 last:pb-0"
                        >
                          <span className="flex-1 truncate text-sm text-foreground">
                            {item.name}
                            <span className="ml-1.5 text-xs text-muted-foreground">
                              · {t(`kind.${item.kind}`)}
                            </span>
                          </span>
                          <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                            {t('cell', {
                              units: item.unitsSold,
                              margin: item.marginPercent,
                              contribution: formatMoney(
                                item.contributionMarginCents,
                                currency,
                              ),
                            })}
                          </span>
                          <ArrowRight
                            className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                            aria-hidden
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {result.needsPricing.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('needsPricing.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('needsPricing.hint')}</p>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {result.needsPricing.map((item) => (
                <li key={`${item.kind}:${item.id}`}>
                  <Link
                    href={itemHref(item.kind, item.id)}
                    className="group flex items-center gap-2 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="flex-1 truncate text-sm text-foreground">
                      {item.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        · {t(`kind.${item.kind}`)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-amber-700 dark:text-amber-300">
                      {t(
                        item.reason === 'MISSING_SELLING_PRICE'
                          ? 'needsPricing.missingPrice'
                          : 'needsPricing.missingCost',
                      )}
                    </span>
                    <ArrowRight
                      className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
