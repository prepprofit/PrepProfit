import { getFormatter, getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { getAiUsageThisMonth } from '@/lib/data/ai-usage';
import { AI_USAGE_FEATURE_LABEL_KEY } from '@/lib/ai/usage-features';

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

        <ul className="flex flex-col gap-4">
          {visible.map((row) => {
            // Truthful bar: clamp to 100% even when a downgrade left `used > limit`.
            const percent = Math.min(100, Math.round((row.used / row.limit) * 100));
            const inFlight = row.reserved - row.used;
            return (
              <li key={row.feature} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
                  <span className="font-medium text-foreground">
                    {t(AI_USAGE_FEATURE_LABEL_KEY[row.feature])}
                  </span>
                  <span className="text-muted-foreground">
                    {t('used', { used: row.used, limit: row.limit })}
                  </span>
                </div>
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
                  role="progressbar"
                  aria-valuenow={row.used}
                  aria-valuemin={0}
                  aria-valuemax={row.limit}
                >
                  <div
                    className="h-full rounded-full bg-accent-500"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
                  <span>{t('remaining', { count: row.remaining })}</span>
                  {inFlight > 0 && <span>{t('inFlight', { count: inFlight })}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
