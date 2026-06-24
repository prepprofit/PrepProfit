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
import { renderPlXlsx } from '@/lib/documents/pl-xlsx';
import { documentFilename } from '@/lib/documents/format';

// write-excel-file + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Profit & Loss XLSX export (Sprint 3.5B). Manager-only and org-scoped (RULE #1):
 * Zod-validated filter, server-derived org id, read inside `withOrg` via the shared
 * `loadPlDocument` so the sheet reconciles with `/financials`. Text cells are
 * formula-injection-neutralized; money is written as real Numbers. Rate-limited
 * (`documents`) and audited (`export.plXlsx`) after a successful render.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!(await isManager())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Advanced documents are a Business-plan feature; fail-closed plan gate (Sprint 4).
  // The advanced-vs-operational boundary lives in the entitlement matrix (audit F-08).
  if (await requireDocumentAccess('pl_xlsx')) {
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

  const xlsx = await renderPlXlsx(data, buildPlLabels(t));
  const filename = `${documentFilename(`pl-${periodKey}`)}.xlsx`;

  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role: 'manager', requestId: crypto.randomUUID() },
      {
        action: 'export.plXlsx',
        entityType: 'report',
        metadata: { view, period: periodKey },
      },
    ),
  );

  return new NextResponse(new Uint8Array(xlsx), {
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
