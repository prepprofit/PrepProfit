import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { getTranslations } from 'next-intl/server';
import { getDb, withOrg } from '@/lib/db';
import {
  claimDueOutbox,
  markOutboxCancelled,
  markOutboxFailed,
  markOutboxSent,
} from '@/lib/data/email-outbox';
import {
  getPurchaseOrderWithItems,
  loadPurchaseOrderLiveContext,
} from '@/lib/data/purchase-orders';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { loadCfoReport } from '@/lib/data/cfo-report';
import { writeAuditEvent } from '@/lib/data/audit';
import { isCronAuthorized } from '@/lib/cron-auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { serverEnv, isEmailConfigured, emailAppUrl } from '@/lib/env';
import { getEmailSender, type EmailSender } from '@/lib/email/resend';
import { renderEmail } from '@/lib/email/render';
import { emailChrome } from '@/lib/email/chrome';
import { PurchaseOrderEmail } from '@/emails/PurchaseOrderEmail';
import { CfoReportEmail, type CfoEmailSection } from '@/emails/CfoReportEmail';
import {
  buildPurchaseOrderDocumentData,
  purchaseOrderDocumentFilename,
} from '@/lib/documents/po-data';
import { buildPurchaseOrderLabels } from '@/lib/documents/po-labels';
import { renderPurchaseOrderPdf } from '@/lib/documents/po-pdf';
import { loadSafeLogo } from '@/lib/documents/logo';
import { formatMoney } from '@/lib/format/money';
import { leakLabel } from '@/lib/profit-leaks/labels';
import { logError } from '@/lib/observability';
import type { CfoReport } from '@/lib/calculations/cfo-report';
import type { Dimension } from '@/lib/units';
import type { EmailOutboxRow } from '@/lib/db/schema';

// @react-pdf/renderer + neon-serverless Pool need Node; never statically cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;
const BATCH_PER_ORG = 20;

/**
 * Email-outbox worker (Sprint 8a; React Email migration). A single lease-based
 * worker that claims due `email_outbox` rows and DISPATCHES delivery by
 * `document_type`: purchase-order send/cancel notices (with a PDF), and the weekly
 * CFO report digest (deterministic, no attachment). AT-LEAST-ONCE + provider-dedup
 * semantics; a row with a `provider_message_id` is never resent.
 *
 * Authenticated by CRON_SECRET (scheduled task), NOT a user session — excluded from
 * Clerk in middleware.ts. Per-organization (RULE #1): claims rows inside `withOrg`
 * (RLS active, `FOR UPDATE SKIP LOCKED`), sends OUTSIDE the claim tx, then records
 * the result in a fresh tx. The CFO path re-checks opt-in/email at send time and
 * loads the deterministic report; it NEVER calls an AI provider.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (!isCronAuthorized(authHeader, serverEnv().CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = await enforceRateLimit(getDb(), 'outboxWorker', authHeader ?? '');
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // No email provider configured → nothing to do (keeps build/CI green without keys).
  if (!isEmailConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'email-not-configured' });
  }

  const sender = getEmailSender();
  const client = await clerkClient();
  const tDoc = await getTranslations('purchaseOrderDocument');
  const tEmail = await getTranslations('purchaseOrderEmail');
  const tCfo = await getTranslations('cfoReport');
  const tCfoEmail = await getTranslations('cfoReportEmail');
  const tLeak = await getTranslations('dashboard.profitLeaks');
  const tEmailNs = await getTranslations('email');
  const labels = buildPurchaseOrderLabels(tDoc);
  const chrome = await emailChrome();
  const deps: DeliverDeps = {
    sender,
    labels,
    tEmail,
    tCfo,
    tCfoEmail,
    tLeak,
    chrome,
    appUrl: emailAppUrl(),
    ctaLabel: tEmailNs('cta.openReport'),
  };

  let offset = 0;
  let processed = 0;
  let sent = 0;
  let failed = 0;
  let cancelled = 0;

  for (;;) {
    const { data, totalCount } = await client.organizations.getOrganizationList({
      limit: PAGE_SIZE,
      offset,
    });
    if (data.length === 0) break;

    for (const org of data) {
      const now = new Date();
      const claimToken = crypto.randomUUID();
      const claimed = await withOrg(org.id, (tx) =>
        claimDueOutbox(tx, org.id, now, claimToken, BATCH_PER_ORG),
      );

      for (const row of claimed) {
        processed += 1;
        const outcome =
          row.documentType === 'cfo_report'
            ? await deliverCfoReportRow(org.id, row, deps)
            : await deliverPurchaseOrderRow(org.id, org.name ?? null, row, deps);
        if (outcome === 'sent') sent += 1;
        else if (outcome === 'cancelled') cancelled += 1;
        else failed += 1;
      }
    }

    offset += data.length;
    if (offset >= totalCount) break;
  }

  return NextResponse.json({ ok: true, processed, sent, failed, cancelled });
}

type DeliverDeps = {
  sender: EmailSender;
  labels: ReturnType<typeof buildPurchaseOrderLabels>;
  tEmail: Awaited<ReturnType<typeof getTranslations>>;
  tCfo: Awaited<ReturnType<typeof getTranslations>>;
  tCfoEmail: Awaited<ReturnType<typeof getTranslations>>;
  tLeak: Awaited<ReturnType<typeof getTranslations>>;
  chrome: Awaited<ReturnType<typeof emailChrome>>;
  appUrl: string | null;
  ctaLabel: string;
};

type Outcome = 'sent' | 'failed' | 'cancelled';

/** Record a failed attempt for a claimed row (never throws). */
async function failRow(
  organizationId: string,
  row: EmailOutboxRow,
  token: string,
  reason: string,
  now: Date,
): Promise<'failed'> {
  try {
    await withOrg(organizationId, (tx) =>
      markOutboxFailed(tx, organizationId, row, token, reason, now),
    );
  } catch (markErr) {
    logError({ action: 'cron.emailOutbox.mark', orgId: organizationId }, markErr);
  }
  return 'failed';
}

/** Deliver one claimed purchase-order row. Never throws. */
async function deliverPurchaseOrderRow(
  organizationId: string,
  orgName: string | null,
  row: EmailOutboxRow,
  deps: DeliverDeps,
): Promise<Outcome> {
  const token = row.claimToken ?? '';
  const now = new Date();
  try {
    const loaded = await withOrg(organizationId, async (tx) => {
      const detail = await getPurchaseOrderWithItems(tx, organizationId, row.documentId);
      if (!detail) return null;
      const settings = await getOrgSettingsRow(tx, organizationId);
      const live = await loadPurchaseOrderLiveContext(tx, organizationId, detail);
      return { detail, settings, live };
    });

    if (!loaded) {
      // The document is gone — terminal-fail the row so it is not retried forever.
      return failRow(organizationId, row, token, 'document not found', now);
    }

    const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
    const data = buildPurchaseOrderDocumentData(
      loaded.detail,
      settings,
      settings.businessName?.trim() ? null : orgName,
      loaded.live,
    );
    data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

    const isCancel = row.dedupKey.endsWith(':cancel');
    const number = data.number;
    const subject = isCancel
      ? deps.tEmail('cancelSubject', { number })
      : deps.tEmail('subject', { number });
    const body = isCancel
      ? deps.tEmail('cancelBody', { number })
      : deps.tEmail('body', { number, seller: data.seller.name });
    const { html, text } = await renderEmail(
      <PurchaseOrderEmail
        {...deps.chrome}
        preview={subject}
        heading={subject}
        body={body}
      />,
    );

    const attachments = isCancel
      ? []
      : [
          {
            filename: `${purchaseOrderDocumentFilename(loaded.detail.order)}.pdf`,
            content: await renderPurchaseOrderPdf(data, deps.labels),
          },
        ];

    const result = await deps.sender.send({
      to: row.toEmail,
      subject,
      html,
      text,
      attachments,
      // Provider-side dedup: a crash after accept but before markOutboxSent does
      // not double-send when this row is reclaimed and retried.
      idempotencyKey: row.dedupKey,
    });

    await withOrg(organizationId, async (tx) => {
      const owned = await markOutboxSent(tx, organizationId, row.id, token, result.id);
      // Audit only AFTER the provider accepted AND we still own the row (metadata is
      // documentType + provider message id only — never recipient/amounts).
      if (owned) {
        await writeAuditEvent(
          tx,
          organizationId,
          { userId: null, role: 'system', requestId: crypto.randomUUID() },
          {
            action: 'document.email',
            entityType: 'purchaseOrder',
            entityId: row.documentId,
            metadata: { documentType: row.documentType, providerMessageId: result.id },
          },
        );
      }
    });
    return 'sent';
  } catch (err) {
    logError({ action: 'cron.emailOutbox', orgId: organizationId }, err);
    return failRow(
      organizationId,
      row,
      token,
      err instanceof Error ? err.message : String(err),
      now,
    );
  }
}

/**
 * Deliver one claimed weekly-CFO-report row. `documentId` is the week-ending date.
 * Re-checks opt-in + business email at send time (cancel — not fail — if the org has
 * since opted out or cleared its email), reloads the DETERMINISTIC report inside
 * `withOrg`, renders it, sends with no attachment, and audits `report.cfoEmail` with
 * non-sensitive counts only. Never calls an AI provider. Never throws.
 */
async function deliverCfoReportRow(
  organizationId: string,
  row: EmailOutboxRow,
  deps: DeliverDeps,
): Promise<Outcome> {
  const token = row.claimToken ?? '';
  const now = new Date();
  const weekTo = row.documentId;
  try {
    const loaded = await withOrg(organizationId, async (tx) => {
      const settings = await getOrgSettingsRow(tx, organizationId);
      if (!settings?.weeklyCfoReportEmailEnabled || !settings.businessEmail) {
        return { cancel: true as const };
      }
      const report = await loadCfoReport(tx, organizationId, weekTo);
      return {
        cancel: false as const,
        toEmail: settings.businessEmail,
        currency: settings.currency,
        report,
      };
    });

    if (loaded.cancel) {
      // Opted out / no destination since enqueue — terminal, but NOT a failure.
      const cancelled = await withOrg(organizationId, (tx) =>
        markOutboxCancelled(tx, organizationId, row.id, token),
      );
      return cancelled ? 'cancelled' : 'failed';
    }

    const { report, currency, toEmail } = loaded;
    const subject = row.subject ?? deps.tCfoEmail('subject', { period: weekTo });
    const props = buildCfoEmailBody(report, currency, deps);
    const { html, text } = await renderEmail(
      <CfoReportEmail
        {...deps.chrome}
        preview={subject}
        heading={deps.tCfo('title')}
        {...props}
      />,
    );

    const result = await deps.sender.send({
      to: toEmail,
      subject,
      html,
      text,
      attachments: [],
      idempotencyKey: row.dedupKey,
    });

    await withOrg(organizationId, async (tx) => {
      const owned = await markOutboxSent(tx, organizationId, row.id, token, result.id);
      // Audit only after acceptance + still owned. Non-sensitive counts/flags only —
      // never the recipient, item names, amounts, or any AI prose (there is none).
      if (owned) {
        await writeAuditEvent(
          tx,
          organizationId,
          { userId: null, role: 'system', requestId: crypto.randomUUID() },
          {
            action: 'report.cfoEmail',
            entityType: 'cfoReport',
            entityId: weekTo,
            metadata: {
              weekTo,
              providerMessageId: result.id,
              leakCount: report.marginLeaks.length,
              repriceCount: report.repriceCandidates.length,
              supplierChangeCount: report.supplierPriceChanges.length,
              lowStockCount: report.lowStock.length,
            },
          },
        );
      }
    });
    return 'sent';
  } catch (err) {
    logError({ action: 'cron.emailOutbox.cfo', orgId: organizationId }, err);
    return failRow(
      organizationId,
      row,
      token,
      err instanceof Error ? err.message : String(err),
      now,
    );
  }
}

const UNIT_LABEL: Record<Dimension, string> = {
  weight: 'g',
  volume: 'ml',
  count: 'pcs',
};

/**
 * Build the CFO email's already-formatted body props from the deterministic report.
 * All money goes through {@link formatMoney}; a null trend renders as "—" and is
 * never a fabricated figure. Pure formatting — no I/O.
 */
function buildCfoEmailBody(
  report: CfoReport,
  currency: string,
  deps: DeliverDeps,
) {
  const { tCfo, tLeak } = deps;
  const fmtQty = (canonical: number, dimension: Dimension) =>
    `${Math.round(canonical).toLocaleString('en-US')} ${UNIT_LABEL[dimension]}`;

  const rev = report.revenue;
  const revChange =
    rev.changePercent == null
      ? ''
      : ` (${rev.changePercent > 0 ? '+' : ''}${rev.changePercent}%)`;
  const fc = report.foodCost;
  const fcValue = fc.thisWeekPercent == null ? '—' : `${fc.thisWeekPercent}%`;
  const fcChange =
    fc.changePoints == null
      ? ''
      : ` (${fc.changePoints > 0 ? '+' : ''}${fc.changePoints} pts)`;

  const summary = [
    {
      label: tCfo('revenue.title'),
      value: `${formatMoney(rev.thisWeekGrossCents, currency)}${revChange}`,
      emphasize: true,
    },
    { label: tCfo('foodCost.title'), value: `${fcValue}${fcChange}` },
  ];

  const sections: CfoEmailSection[] = [];
  if (report.marginLeaks.length > 0) {
    sections.push({
      title: tCfo('leaks.title'),
      items: report.marginLeaks.map((f) => ({
        left: leakLabel(f, report.targetMarginPercent, tLeak),
      })),
    });
  }
  if (report.repriceCandidates.length > 0) {
    sections.push({
      title: tCfo('reprice.title'),
      items: report.repriceCandidates.map((c) => ({
        left: c.entityName,
        right:
          c.suggestedPriceCents != null
            ? `${tCfo('reprice.margin', { margin: c.currentMarginPercent })} · ${tCfo(
                'reprice.suggested',
                { price: formatMoney(c.suggestedPriceCents, currency) },
              )}`
            : tCfo('reprice.margin', { margin: c.currentMarginPercent }),
      })),
    });
  }
  if (report.supplierPriceChanges.length > 0) {
    sections.push({
      title: tCfo('supplierChanges.title'),
      items: report.supplierPriceChanges.map((c) => ({
        left: c.name,
        right: `${formatMoney(c.fromCents, currency)} → ${formatMoney(c.toCents, currency)}${
          c.changePercent == null
            ? ''
            : ` (${c.changePercent > 0 ? '+' : ''}${c.changePercent}%)`
        }`,
      })),
    });
  }
  if (report.lowStock.length > 0) {
    sections.push({
      title: tCfo('lowStock.title'),
      items: report.lowStock.map((l) => ({
        left: l.name,
        right: tCfo('lowStock.onHand', {
          onHand: fmtQty(l.onHandCanonical, l.dimension),
          threshold: fmtQty(l.thresholdCanonical, l.dimension),
        }),
      })),
    });
  }

  const confidenceNotes = report.confidence.map((n) =>
    tCfo(`confidence.code.${n.code}`, { count: n.count }),
  );

  const cta = deps.appUrl
    ? {
        href: `${deps.appUrl}/reports/cfo?weekTo=${report.weekTo}`,
        label: deps.ctaLabel,
      }
    : undefined;

  return {
    periodLabel: tCfo('period.range', { from: report.weekFrom, to: report.weekTo }),
    summary,
    sections,
    confidenceTitle: tCfo('confidence.title'),
    confidenceNotes,
    cta,
  };
}
