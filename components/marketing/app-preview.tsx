import { getTranslations } from 'next-intl/server';
import { TrendingUp, Percent, Tag } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatCard } from '@/components/ui/stat-card';

// Representative sample figures for the marketing preview only (clearly tagged
// "Sample data" in the UI). Not pulled from any real organization.
const PROFIT_BARS = [38, 52, 47, 63, 58, 74];

/**
 * A small, genuine product preview assembled from PrepProfit's own UI primitives
 * (StatCard / Card / Badge) plus a CSS bar chart. This is a real component
 * preview, not a div-based fake screenshot.
 */
export async function AppPreview() {
  const t = await getTranslations('marketing.preview');
  const max = Math.max(...PROFIT_BARS);

  return (
    <div className="relative">
      {/* Accent glow under the floating preview */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] opacity-70 blur-2xl"
        style={{
          background:
            'radial-gradient(60% 60% at 70% 20%, color-mix(in oklab, var(--color-accent-500) 22%, transparent), transparent)',
        }}
      />

      <Card
        variant="glass"
        className="overflow-hidden p-5 shadow-xl sm:p-6"
        aria-label={t('recipe')}
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <p className="font-display text-lg font-semibold text-foreground">
              {t('recipe')}
            </p>
            <p className="text-xs text-muted-foreground">{t('months')}</p>
          </div>
          <Badge variant="neutral">{t('tag')}</Badge>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <StatCard
            label={t('foodCost')}
            value="€2.41"
            icon={Percent}
            delta={{
              label: '4 pts',
              tone: 'positive',
              direction: 'down',
            }}
          />
          <StatCard
            label={t('margin')}
            value="68%"
            featured
            icon={TrendingUp}
          />
          <StatCard label={t('price')} value="€7.50" icon={Tag} />
          <Card className="flex flex-col gap-3 p-5">
            <span className="text-sm font-medium text-muted-foreground">
              {t('chartTitle')}
            </span>
            <div
              className="flex h-16 items-end gap-1.5"
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
      </Card>
    </div>
  );
}
