import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { getTranslations } from 'next-intl/server';
import { getDb, withOrg } from '@/lib/db';
import { getOrgSettingsRow } from '@/lib/data/org-settings';
import { resolveSystemJobTier } from '@/lib/data/system-entitlements';
import { loadCfoReport, defaultCfoWeekTo } from '@/lib/data/cfo-report';
import { enqueueEmail } from '@/lib/data/email-outbox';
import { isCronAuthorized } from '@/lib/cron-auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { serverEnv, isEmailConfigured } from '@/lib/env';
import { logError } from '@/lib/observability';

// neon-serverless Pool needs Node; the enqueue is computed fresh each run.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

/**
 * Weekly CFO report ENQUEUE cron (React Email migration). Once a week it walks every
 * Clerk organization and, for each opted-in paid org with a business email and real
 * data, queues ONE `cfo_report` row in `email_outbox`. The existing outbox worker
 * (process-email-outbox) then renders + delivers it with the same retry/dedupe
 * semantics as purchase-order mail — so this route never sends, it only enqueues.
 *
 * Authenticated by CRON_SECRET (Vercel Cron), NOT a user session — excluded from
 * Clerk in middleware.ts. RULE #1 preserved: all per-org work (settings read, tier
 * resolution, report load, enqueue) runs inside that org's own `withOrg` (RLS
 * active); there is NO cross-tenant query.
 *
 * Idempotent: the outbox unique `(organization_id, dedup_key)` means a re-run for the
 * same week never queues a duplicate. Deterministic only — it loads
 * {@link loadCfoReport} and NEVER calls an AI provider (automated AI spend needs its
 * own product approval; plan §7).
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (!isCronAuthorized(authHeader, serverEnv().CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = await enforceRateLimit(getDb(), 'cfoReportEnqueue', authHeader ?? '');
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // No email provider configured → nothing to queue (keeps build/CI green without
  // keys and lets the feature stay dormant until email is set up).
  if (!isEmailConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'email-not-configured' });
  }

  const now = new Date();
  const weekTo = defaultCfoWeekTo(now);
  const client = await clerkClient();
  const t = await getTranslations('cfoReportEmail');
  const subject = t('subject', { period: weekTo });

  let offset = 0;
  let queued = 0;

  for (;;) {
    const { data, totalCount } = await client.organizations.getOrganizationList({
      limit: PAGE_SIZE,
      offset,
    });
    if (data.length === 0) break;

    for (const org of data) {
      try {
        const enqueued = await withOrg(org.id, async (tx) => {
          const settings = await getOrgSettingsRow(tx, org.id);
          // Opt-in OFF, or no destination address → skip.
          if (!settings?.weeklyCfoReportEmailEnabled) return false;
          if (!settings.businessEmail) return false;
          // Paid tiers only; Starter (or an unknown mirror) is skipped fail-closed.
          const tier = await resolveSystemJobTier(tx, org.id);
          if (tier === 'starter') return false;
          // Nothing to say this week → don't send an empty digest.
          const report = await loadCfoReport(tx, org.id, weekTo);
          if (!report.hasData) return false;

          const row = await enqueueEmail(tx, org.id, {
            documentType: 'cfo_report',
            documentId: weekTo,
            toEmail: settings.businessEmail,
            subject,
            dedupKey: `cfo_report:${weekTo}`,
          });
          // `null` = a row already existed for this (org, week): idempotent no-op.
          return row !== null;
        });
        if (enqueued) queued += 1;
      } catch (err) {
        logError({ action: 'cron.cfoReportEnqueue', orgId: org.id }, err);
      }
    }

    offset += data.length;
    if (offset >= totalCount) break;
  }

  return NextResponse.json({ ok: true, weekTo, queued });
}
