import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import { getTranslations } from 'next-intl/server';
import { getDb, withOrg } from '@/lib/db';
import {
  claimDueOutbox,
  markOutboxFailed,
  markOutboxSent,
} from '@/lib/data/email-outbox';
import {
  getPurchaseOrderWithItems,
  loadPurchaseOrderLiveContext,
} from '@/lib/data/purchase-orders';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { isCronAuthorized } from '@/lib/cron-auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { serverEnv, isEmailConfigured } from '@/lib/env';
import { getEmailSender, type EmailSender } from '@/lib/email/resend';
import {
  buildPurchaseOrderDocumentData,
  purchaseOrderDocumentFilename,
} from '@/lib/documents/po-data';
import { buildPurchaseOrderLabels } from '@/lib/documents/po-labels';
import { renderPurchaseOrderPdf } from '@/lib/documents/po-pdf';
import { loadSafeLogo } from '@/lib/documents/logo';
import { logError } from '@/lib/observability';
import type { EmailOutboxRow } from '@/lib/db/schema';

// @react-pdf/renderer + neon-serverless Pool need Node; never statically cache.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;
const BATCH_PER_ORG = 20;

/**
 * Email-outbox worker (Sprint 8a). Delivers queued document emails (PO send/cancel
 * notices) with AT-LEAST-ONCE + provider-dedup semantics. Authenticated by
 * CRON_SECRET (Vercel Cron), NOT a user session — excluded from Clerk in
 * middleware.ts. Per-organization (RULE #1): claims rows inside `withOrg` (RLS
 * active, `FOR UPDATE SKIP LOCKED` so two workers never grab the same row), sends
 * OUTSIDE the claim tx, then records the result in a fresh tx. A row that already
 * has a `provider_message_id` is never resent.
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
  const labels = buildPurchaseOrderLabels(tDoc);

  let offset = 0;
  let processed = 0;
  let sent = 0;
  let failed = 0;

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
        const outcome = await deliverRow(org.id, org.name ?? null, row, {
          sender,
          labels,
          tEmail,
        });
        if (outcome === 'sent') sent += 1;
        else failed += 1;
      }
    }

    offset += data.length;
    if (offset >= totalCount) break;
  }

  return NextResponse.json({ ok: true, processed, sent, failed });
}

type DeliverDeps = {
  sender: EmailSender;
  labels: ReturnType<typeof buildPurchaseOrderLabels>;
  tEmail: Awaited<ReturnType<typeof getTranslations>>;
};

/** Deliver one claimed outbox row; returns 'sent' | 'failed'. Never throws. */
async function deliverRow(
  organizationId: string,
  orgName: string | null,
  row: EmailOutboxRow,
  deps: DeliverDeps,
): Promise<'sent' | 'failed'> {
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
      await withOrg(organizationId, (tx) =>
        markOutboxFailed(tx, organizationId, row, token, 'document not found', now),
      );
      return 'failed';
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
    const html = isCancel
      ? deps.tEmail('cancelBody', { number })
      : deps.tEmail('body', { number, seller: data.seller.name });

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
    try {
      await withOrg(organizationId, (tx) =>
        markOutboxFailed(
          tx,
          organizationId,
          row,
          token,
          err instanceof Error ? err.message : String(err),
          now,
        ),
      );
    } catch (markErr) {
      logError({ action: 'cron.emailOutbox.mark', orgId: organizationId }, markErr);
    }
    return 'failed';
  }
}
