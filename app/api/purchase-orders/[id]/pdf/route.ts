import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getOrgName, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import {
  getPurchaseOrderWithItems,
  loadPurchaseOrderLiveContext,
} from '@/lib/data/purchase-orders';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import {
  buildPurchaseOrderDocumentData,
  purchaseOrderDocumentFilename,
} from '@/lib/documents/po-data';
import { buildPurchaseOrderLabels } from '@/lib/documents/po-labels';
import { renderPurchaseOrderPdf } from '@/lib/documents/po-pdf';
import { loadSafeLogo } from '@/lib/documents/logo';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Purchase-order PDF download (Sprint 8a) — a justified API route (file download).
 * Manager-only and org-scoped (RULE #1): the org id is derived server-side and the
 * read runs inside `withOrg` so RLS is active. A cross-org or non-existent id returns
 * 404. Rate-limited (`documents` bucket) and audited (`export.purchaseOrderPdf`) only
 * AFTER a successful render. POs are not plan-gated (all plans, Sprint 8a decision).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await isManager())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const organizationId = await getOrgId();
  const userId = await getUserId();

  const limit = await enforceRateLimit(
    getDb(),
    'documents',
    `${organizationId}:${userId}`,
  );
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { id } = await params;

  const loaded = await withOrg(organizationId, async (tx) => {
    const detail = await getPurchaseOrderWithItems(tx, organizationId, id);
    if (!detail) return null;
    const settings = await getOrgSettingsRow(tx, organizationId);
    const live = await loadPurchaseOrderLiveContext(tx, organizationId, detail);
    return { detail, settings, live };
  });

  if (!loaded) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const t = await getTranslations('purchaseOrderDocument');
  const data = buildPurchaseOrderDocumentData(
    loaded.detail,
    settings,
    orgName,
    loaded.live,
  );
  // SSRF/DoS-safe: fetch + validate the logo ourselves and embed local bytes.
  data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

  const pdf = await renderPurchaseOrderPdf(data, buildPurchaseOrderLabels(t));
  const filename = `${purchaseOrderDocumentFilename(loaded.detail.order)}.pdf`;

  // Audit only now that the PDF rendered (status/number only — no contact PII).
  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role: 'manager', requestId: crypto.randomUUID() },
      {
        action: 'export.purchaseOrderPdf',
        entityType: 'purchaseOrder',
        entityId: id,
        metadata: {
          status: loaded.detail.order.status,
          number: loaded.detail.order.number,
        },
      },
    ),
  );

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
