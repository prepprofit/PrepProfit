import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle, Plus } from 'lucide-react';
import type { MarginLight } from '@/lib/calculations/margin';
import type { MenuAllergen } from '@/lib/calculations/menu';
import { formatMoney } from '@/lib/format/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { MenuAllergenChips } from './menu-allergen-chips';

const LIGHT_VARIANT: Record<MarginLight, 'positive' | 'warning' | 'negative'> = {
  green: 'positive',
  yellow: 'warning',
  red: 'negative',
};

/** Manager-only KPI bundle; absent entirely for kitchen (F4 — money never shipped). */
export type ListMenuKpis = {
  sellingPriceCents: number | null;
  costCents: number | null;
  foodCostPercent: number | null;
  marginPercent: number | null;
  trafficLight: MarginLight | null;
};

export type ListMenu = {
  id: string;
  name: string;
  notes: string | null;
  itemCount: number;
  complete: boolean;
  allergens: MenuAllergen[];
  hasUnreviewedIngredient: boolean;
  /** Manager only. Kitchen list items omit this key, so no money reaches the client. */
  kpis?: ListMenuKpis;
};

/**
 * Menu list (Sprint 10), rendered for BOTH roles. Both see name, component count,
 * availability and allergens. A manager additionally sees price/cost/food-cost/
 * margin and the New/Edit controls (`canManage`). An incomplete menu shows `—` for
 * money, never a partial total.
 */
export async function MenusList({
  menus,
  canManage,
  currency,
}: {
  menus: ListMenu[];
  canManage: boolean;
  currency: string;
}) {
  const t = await getTranslations('menus');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        {canManage && (
          <Button asChild>
            <Link href="/menus/new">
              <Plus className="size-4" />
              {t('actions.new')}
            </Link>
          </Button>
        )}
      </div>

      {menus.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-12 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {menus.map((menu) => (
            <Card key={menu.id} className="transition-colors hover:border-accent-300">
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/menus/${menu.id}`}
                    className="font-display text-base font-semibold text-foreground hover:text-accent-700"
                  >
                    {menu.name}
                  </Link>
                  {!menu.complete && (
                    <Badge variant="warning">
                      <AlertTriangle className="size-3" />
                      {t('incomplete.badge')}
                    </Badge>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  {t('itemCount', { count: menu.itemCount })}
                </p>

                {canManage && menu.kpis && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <KpiPair
                      label={t('kpis.price')}
                      value={
                        menu.kpis.sellingPriceCents != null
                          ? formatMoney(menu.kpis.sellingPriceCents, currency)
                          : '—'
                      }
                    />
                    <KpiPair
                      label={t('kpis.cost')}
                      value={
                        menu.kpis.costCents != null
                          ? formatMoney(menu.kpis.costCents, currency)
                          : '—'
                      }
                    />
                    <KpiPair
                      label={t('kpis.foodCost')}
                      value={
                        menu.kpis.foodCostPercent != null
                          ? `${menu.kpis.foodCostPercent}%`
                          : '—'
                      }
                    />
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        {t('kpis.margin')}
                      </span>
                      {menu.kpis.marginPercent != null && menu.kpis.trafficLight ? (
                        <Badge variant={LIGHT_VARIANT[menu.kpis.trafficLight]}>
                          {menu.kpis.marginPercent}%
                        </Badge>
                      ) : (
                        <span className="tabular-nums text-muted-foreground">—</span>
                      )}
                    </span>
                  </div>
                )}

                <MenuAllergenChips
                  allergens={menu.allergens}
                  hasUnreviewedIngredient={menu.hasUnreviewedIngredient}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function KpiPair({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </span>
  );
}
