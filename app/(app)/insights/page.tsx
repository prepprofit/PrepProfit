import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { loadProfitLeaks } from '@/lib/data/profit-leaks';
import { listInsightStates } from '@/lib/data/profit-insights';
import { leakHref, leakLabel } from '@/lib/profit-leaks/labels';
import { MARGIN_THRESHOLDS } from '@/lib/calculations/margin';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  InsightRow,
  type InsightRowData,
} from '@/components/app/insights/insight-row';

/**
 * Profit Insight Inbox (Sprint 4, AI margin roadmap). Manager-only — mirrors the
 * dashboard guard (kitchen is redirected; margin risk is financial data). Lists every
 * deterministic profit-leak finding with an AI "Explain" action and dismiss/resolve
 * triage. Findings are recomputed here (never stored); only the sidecar state (cached
 * explanation + dismiss flag) is loaded and merged in.
 */
export default async function InsightsPage() {
  const t = await getTranslations('insights');
  const tLeaks = await getTranslations('dashboard.profitLeaks');
  const organizationId = await getOrgId();

  if (!canAccessFinancials(await getUserRole())) {
    redirect('/recipes');
  }

  const { findings, states } = await withOrg(organizationId, async (tx) => {
    const findings = await loadProfitLeaks(tx, organizationId);
    const states = await listInsightStates(
      tx,
      organizationId,
      findings.map((f) => f.fingerprint),
    );
    return { findings, states };
  });

  const target = MARGIN_THRESHOLDS.green;
  const rows: InsightRowData[] = findings.map((f) => {
    const state = states.get(f.fingerprint);
    return {
      fingerprint: f.fingerprint,
      label: leakLabel(f, target, (key, values) => tLeaks(key, values)),
      href: leakHref(f),
      severity: f.severity,
      explanation: state?.explanation ?? null,
      dismissed: state?.dismissedAt != null,
    };
  });

  const active = rows.filter((r) => !r.dismissed);
  const dismissed = rows.filter((r) => r.dismissed);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle', { target })}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('activeHeading', { count: active.length })}</CardTitle>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty', { target })}</p>
          ) : (
            <div className="divide-y divide-border">
              {active.map((row) => (
                <InsightRow key={row.fingerprint} data={row} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {dismissed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('dismissedHeading', { count: dismissed.length })}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {dismissed.map((row) => (
                <InsightRow key={row.fingerprint} data={row} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
