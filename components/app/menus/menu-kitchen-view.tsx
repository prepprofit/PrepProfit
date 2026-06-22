import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import type { KitchenMenuDetail } from '@/lib/data/menus';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MenuAllergenChips } from './menu-allergen-chips';

/**
 * Read-only, money-free menu detail for the kitchen role (Sprint 10, F4). Shows the
 * composition (recipe names + portion quantities), availability, allergens and
 * notes — never price, cost, food-cost or margin.
 */
export async function MenuKitchenView({ menu }: { menu: KitchenMenuDetail }) {
  const t = await getTranslations('menus');

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/menus"
          className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label={t('actions.back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="font-display text-xl font-semibold text-foreground">
          {menu.name}
        </h1>
        {!menu.complete && (
          <Badge variant="warning">
            <AlertTriangle className="size-3" />
            {t('incomplete.badge')}
          </Badge>
        )}
      </div>

      {!menu.complete && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
        >
          {t('incomplete.kitchenBody')}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('composition.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <ul className="flex flex-col divide-y divide-border">
            {menu.lines.map((line) => (
              <li
                key={line.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium text-foreground">
                    {line.recipeName}
                  </span>
                  {!line.available && (
                    <Badge variant="warning">{t('unavailableLine')}</Badge>
                  )}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {t('portions', { count: line.quantity })}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('allergens.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <MenuAllergenChips
            allergens={menu.allergens}
            hasUnreviewedIngredient={menu.hasUnreviewedIngredient}
          />
        </CardContent>
      </Card>

      {menu.notes && (
        <Card>
          <CardHeader>
            <CardTitle>{t('fields.notes')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-foreground">{menu.notes}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
