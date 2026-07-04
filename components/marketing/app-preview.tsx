import { getTranslations } from 'next-intl/server';
import { TrendingUp, Percent, Tag, Wallet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatCard } from '@/components/ui/stat-card';

// Representative sample figures for the marketing preview only (clearly tagged
// "Sample data" in the UI). Not pulled from any real organization.
const PROFIT_BARS = [42, 55, 48, 63, 58, 71, 66, 78, 74, 85, 81, 92];
const TOP_DISHES = [
  { name: 'Margherita Pizza', margin: 68 },
  { name: 'Croissant', margin: 61 },
  { name: 'Crème Brûlée', margin: 57 },
  { name: 'House Burger', margin: 52 },
] as const;

/**
 * Wide, browser-framed product preview assembled from PrepProfit's own UI
 * primitives (StatCard / Card / Badge) plus a CSS bar chart. This is a real
 * component preview, not a screenshot — and uses clearly labelled sample data.
 */
export async function AppPreview() {
  const t = await getTranslations('marketing.preview');
  const max = Math.max(...PROFIT_BARS);

  return (
    <div className="relative">
      {/* Accent glow under the floating preview */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-10 -top-10 bottom-0 -z-10 rounded-[2.5rem] opacity-70 blur-3xl"
        style={{
          background:
            'radial-gradient(50% 60% at 50% 0%, color-mix(in oklab, var(--color-accent-500) 22%, transparent), transparent)',
        }}
      />

      <Card
        variant="glass"
        className="overflow-hidden p-0 shadow-2xl"
        aria-label={t('dashboard')}
      >
        {/* Browser chrome */}
        <div className="flex items-center gap-2 border-b border-glass-border bg-surface-2/60 px-4 py-3">
          <span className="size-3 rounded-full bg-red-400/80" />
          <span className="size-3 rounded-full bg-amber-400/80" />
          <span className="size-3 rounded-full bg-brand-400/80" />
          <div className="ml-3 hidden flex-1 sm:block">
            <div className="mx-auto w-fit rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted-foreground">
              prepprofit.com/dashboard
            </div>
          </div>
        </div>

        {/* Dashboard body */}
        <div className="p-5 sm:p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="font-display text-lg font-semibold text-foreground">
                {t('dashboard')}
              </p>
              <p className="text-xs text-muted-foreground">{t('months')}</p>
            </div>
            <Badge variant="neutral">{t('tag')}</Badge>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            {/* Left column — KPIs + chart */}
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatCard
                  label={t('margin')}
                  value="68%"
                  featured
                  icon={TrendingUp}
                />
                <StatCard
                  label={t('foodCost')}
                  value="$2.41"
                  icon={Percent}
                  delta={{ label: '4 pts', tone: 'positive', direction: 'down' }}
                />
                <StatCard
                  label={t('revenue')}
                  value="$18.6k"
                  icon={Wallet}
                  delta={{ label: '12%', tone: 'positive', direction: 'up' }}
                />
              </div>

              <Card className="flex flex-col gap-3 p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">
                    {t('chartTitle')}
                  </span>
                  <Badge variant="positive">+18%</Badge>
                </div>
                <div
                  className="flex h-28 items-end gap-1.5"
                  role="img"
                  aria-label={t('chartTitle')}
                >
                  {PROFIT_BARS.map((value, i) => (
                    <div
                      key={i}
                      className="flex-1 rounded-t-sm bg-accent-500/80 last:bg-accent-600"
                      style={{ height: `${(value / max) * 100}%` }}
                    />
                  ))}
                </div>
              </Card>
            </div>

            {/* Right column — top dishes by margin */}
            <Card className="flex flex-col gap-4 p-5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-muted-foreground">
                  {t('topDishes')}
                </span>
                <Tag className="size-4 text-accent-500" aria-hidden />
              </div>
              <ul className="flex flex-col gap-3.5">
                {TOP_DISHES.map((dish) => (
                  <li key={dish.name} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground">
                        {dish.name}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {dish.margin}%
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{ width: `${dish.margin}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </Card>
    </div>
  );
}
