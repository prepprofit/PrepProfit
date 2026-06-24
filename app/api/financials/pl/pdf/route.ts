import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { requireDocumentAccess } from '@/lib/entitlements';
import { getDb, withOrg } from '@/lib/db';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { currentPeriodKey, type PeriodView } from '@/lib/finance/period';
import { plReportFilterSchema } from '@/lib/validation/reports';
import { loadPlDocument } from '@/lib/documents/pl-loader';
import { buildPlLabels } from '@/lib/documents/pl-labels';
import { renderPlPdf } from '@/lib/documents/pl-pdf';
import { loadSafeLogo } from '@/lib/documents/logo';
import { documentFilename } from '@/lib/documents/format';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Profit & Loss PDF download (Sprint 3.5B). Manager-only and org-scoped (RULE #1):
 * the period filter is Zod-validated, the org id is derived server-side, and the
 * read runs inside `withOrg` (RLS active) via the shared `loadPlDocument` — the same
 * loader the print page uses, so the document reconciles with `/financials`.
 * Rate-limited (`documents`) and audited (`export.plPdf`) after a successful render.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!(await isManager())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Advanced documents are a Business-plan feature; fail-closed plan gate (Sprint 4).
  // The advanced-vs-operational boundary lives in the entitlement matrix (audit F-08).
  if (await requireDocumentAccess('pl_pdf')) {
    return NextResponse.json({ error: 'Upgrade required' }, { status: 402 });
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

  const { searchParams } = new URL(req.url);
  const parsed = plReportFilterSchema.safeParse({
    view: searchParams.get('view') || undefined,
    period: searchParams.get('period') || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid filter' }, { status: 400 });
  }

  const view = parsed.data.view as PeriodView;
  const periodKey = parsed.data.period ?? currentPeriodKey(view);

  const tCat = await getTranslations('finance.categories');
  const t = await getTranslations('plDocument');
  const data = await loadPlDocument({ view, periodKey, tCat });
  data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

  const pdf = await renderPlPdf(data, buildPlLabels(t));
  const filename = `${documentFilename(`pl-${periodKey}`)}.pdf`;

  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role: 'manager', requestId: crypto.randomUUID() },
      {
        action: 'export.plPdf',
        entityType: 'report',
        metadata: { view, period: periodKey },
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
