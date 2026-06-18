import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getOrgName, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { getInvoiceWithItems } from '@/lib/data/invoices';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { buildInvoiceDocumentData, invoiceDocumentFilename } from '@/lib/documents/invoice-data';
import { buildInvoiceLabels } from '@/lib/documents/invoice-labels';
import { renderInvoicePdf } from '@/lib/documents/invoice-pdf';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Invoice PDF download (Sprint 3.5A) — a justified API route (file download).
 * Manager-only and org-scoped (RULE #1): the org id is derived server-side and
 * the read runs inside `withOrg` so RLS is active. A cross-org or non-existent id
 * returns 404 (never leaks existence). Rate-limited (`documents` bucket) and
 * audit-logged (`export.invoicePdf`) from day one.
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

  // Abuse control (Sprint 3.1): per org+user, on the un-scoped infra table.
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
    const detail = await getInvoiceWithItems(tx, organizationId, id);
    if (!detail) return null;
    const settings = await getOrgSettingsRow(tx, organizationId);
    // Audit the document generation: who exported which invoice (status/number
    // only — no amounts or PII).
    await writeAuditEvent(
      tx,
      organizationId,
      { userId, role: 'manager', requestId: crypto.randomUUID() },
      {
        action: 'export.invoicePdf',
        entityType: 'invoice',
        entityId: id,
        metadata: { status: detail.invoice.status, number: detail.invoice.number },
      },
    );
    return { detail, settings };
  });

  if (!loaded) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const orgName = await getOrgName();
  const t = await getTranslations('invoiceDocument');
  const data = buildInvoiceDocumentData(
    loaded.detail,
    loaded.settings ?? DEFAULT_ORG_SETTINGS,
    orgName,
  );
  const pdf = await renderInvoicePdf(data, buildInvoiceLabels(t));
  const filename = `${invoiceDocumentFilename(loaded.detail.invoice)}.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
