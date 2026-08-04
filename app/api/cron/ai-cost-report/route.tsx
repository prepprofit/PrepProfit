import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { getTranslations } from 'next-intl/server';
import { getDb, withOrg } from '@/lib/db';
import { sumExtractionCostSince, type ExtractionCostSummary } from '@/lib/data/ai-extraction';
import { isCronAuthorized } from '@/lib/cron-auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { serverEnv, isEmailConfigured, aiCostReportRecipient } from '@/lib/env';
import { getEmailSender } from '@/lib/email/resend';
import { renderEmail } from '@/lib/email/render';
import { emailChrome } from '@/lib/email/chrome';
import { AiCostReportEmail } from '@/emails/AiCostReportEmail';
import { formatCostMicrosUsd } from '@/lib/ai/pricing';
import { RECIPE_EXTRACTION_MODEL } from '@/lib/ai/recipe-extraction';
import { logError } from '@/lib/observability';

// neon-serverless Pool needs Node; the report is computed fresh each run.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;
const REPORT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Weekly AI-spend report (operator tooling). Sums every org's `succeeded` extraction
 * cost over the last 7 days and emails the operator a single digest, so the owner can
 * see Gemini provider spend and project it.
 *
 * Authenticated by CRON_SECRET (scheduled task), NOT a user session — excluded from Clerk
 * in middleware.ts. RULE #1 is preserved: the cross-org TOTAL is built by summing each
 * org's own `withOrg` (RLS-active) query — there is NO cross-tenant query. The email
 * carries only aggregate counts/tokens/cost and org names — never recipe or PII data.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (!isCronAuthorized(authHeader, serverEnv().CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = await enforceRateLimit(getDb(), 'aiCostReport', authHeader ?? '');
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // No email provider, or no configured recipient → nothing to send (keeps build/CI
  // green without keys, and lets the feature stay dormant until the operator opts in).
  const recipient = aiCostReportRecipient();
  if (!isEmailConfigured() || !recipient) {
    return NextResponse.json({ ok: true, skipped: 'report-not-configured' });
  }

  const now = new Date();
  const since = new Date(now.getTime() - REPORT_WINDOW_MS);
  const client = await clerkClient();

  // Per-org totals (each summed under its own RLS-scoped tx), accumulated into a grand
  // total. A failure on one org is logged and skipped so one bad org never blocks the
  // whole report.
  const perOrg: { name: string; summary: ExtractionCostSummary }[] = [];
  const total: ExtractionCostSummary = { count: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 };

  let offset = 0;
  for (;;) {
    const { data, totalCount } = await client.organizations.getOrganizationList({
      limit: PAGE_SIZE,
      offset,
    });
    if (data.length === 0) break;

    for (const org of data) {
      try {
        const summary = await withOrg(org.id, (tx) =>
          sumExtractionCostSince(tx, org.id, since),
        );
        if (summary.count > 0) {
          perOrg.push({ name: org.name ?? org.id, summary });
          total.count += summary.count;
          total.inputTokens += summary.inputTokens;
          total.outputTokens += summary.outputTokens;
          total.costMicros += summary.costMicros;
        }
      } catch (err) {
        logError({ action: 'cron.aiCostReport', orgId: org.id }, err);
      }
    }

    offset += data.length;
    if (offset >= totalCount) break;
  }

  const t = await getTranslations('aiCostReport');
  const chrome = await emailChrome();
  const period = `${since.toISOString().slice(0, 10)} – ${now.toISOString().slice(0, 10)}`;
  const subject = t('subject', { period });
  const avgMicros = total.count > 0 ? Math.round(total.costMicros / total.count) : null;
  const { html, text } = await renderEmail(
    <AiCostReportEmail
      {...chrome}
      preview={subject}
      heading={t('heading')}
      periodLabel={t('period', { period })}
      totals={[
        { label: t('totalSpend'), value: formatCostMicrosUsd(total.costMicros), emphasize: true },
        { label: t('extractions'), value: num(total.count) },
        { label: t('avgPerCall'), value: formatCostMicrosUsd(avgMicros) },
        { label: t('inputTokens'), value: num(total.inputTokens) },
        { label: t('outputTokens'), value: num(total.outputTokens) },
      ]}
      byOrgTitle={t('byOrg')}
      orgHeader={{
        name: t('orgColumn'),
        count: t('extractions'),
        spend: t('totalSpend'),
      }}
      orgRows={perOrg.map((o) => ({
        name: o.name,
        count: num(o.summary.count),
        spend: formatCostMicrosUsd(o.summary.costMicros),
      }))}
      emptyText={t('noOrgActivity')}
      notes={[t('model', { model: RECIPE_EXTRACTION_MODEL }), t('estimateNote')]}
    />,
  );

  try {
    await getEmailSender().send({
      to: recipient,
      subject,
      html,
      text,
      attachments: [],
      // One report per UTC day the cron fires — a Vercel retry of the same run won't
      // double-send.
      idempotencyKey: `ai-cost-report:${now.toISOString().slice(0, 10)}`,
    });
  } catch (err) {
    logError({ action: 'cron.aiCostReport.send' }, err);
    return NextResponse.json({ ok: false, error: 'send-failed' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, orgs: perOrg.length, extractions: total.count });
}

const num = (n: number): string => n.toLocaleString('en-US');
