import { getFormatter, getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { getAiUsageThisMonth } from '@/lib/data/ai-usage';
import { AiUsageCarousel } from './ai-usage-carousel';

/**
 * Manager-only "AI usage this month" card on `/billing` (usage meter, 2026-07). Renders
 * one row per metered AI feature the plan actually grants (limit > 0), each showing
 * `used / limit` and a thin progress bar. DISPLAY only — the numbers come from
 * {@link getAiUsageThisMonth}, which reports the ledgers; every AI call is still gated
 * server-side by the per-feature caps. The parent page enforces the manager gate, so
 * this component assumes an authorized viewer.
 */
export async function AiUsagePanel() {
  const t = await getTranslations('billing.aiUsage');
  const format = await getFormatter();
  const { source, resetAt, rows } = await getAiUsageThisMonth();

  // Only features the current plan grants a real allowance are worth showing.
  const visible = rows.filter((row) => row.limit > 0);
  if (visible.length === 0) return null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-display text-lg font-semibold text-foreground">
            {t('title')}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('resetsOn', { date: format.dateTime(resetAt, { dateStyle: 'long' }) })}
          </span>
        </div>

        {source === 'trial' && (
          <p className="text-xs text-muted-foreground">{t('trialNote')}</p>
        )}

        {/* One feature at a time; the arrows/dots cycle through the rest. */}
        <AiUsageCarousel rows={visible} />
      </CardContent>
    </Card>
  );
}
