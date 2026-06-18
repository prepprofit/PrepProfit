import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { todayAnchor, type PayrollView } from '@/lib/payroll/period';
import { payrollReportFilterSchema } from '@/lib/validation/reports';
import { loadPayrollDocument } from '@/lib/documents/payroll-loader';
import { buildPayrollLabels } from '@/lib/documents/payroll-labels';
import { renderPayrollPdf } from '@/lib/documents/payroll-pdf';
import { loadSafeLogo } from '@/lib/documents/logo';
import { documentFilename } from '@/lib/documents/format';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Payroll period-summary PDF download (Sprint 3.5B). Manager-only (payroll is PII /
 * financial) and org-scoped (RULE #1): Zod-validated period, server-derived org id,
 * read inside `withOrg` via the shared `loadPayrollDocument` so it reconciles with
 * `/payroll`. Rate-limited (`documents`) and audited (`export.payrollPdf`) after a
 * successful render — the audit metadata is COUNTS ONLY (no names, no per-person
 * pay).
 */
export async function GET(req: Request): Promise<NextResponse> {
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

  const { searchParams } = new URL(req.url);
  const parsed = payrollReportFilterSchema.safeParse({
    view: searchParams.get('view') || undefined,
    d: searchParams.get('d') || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid filter' }, { status: 400 });
  }

  const view = parsed.data.view as PayrollView;
  const anchor = parsed.data.d ?? todayAnchor();

  const t = await getTranslations('payrollDocument');
  const data = await loadPayrollDocument({ view, anchor });
  data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

  const pdf = await renderPayrollPdf(data, buildPayrollLabels(t));
  const filename = `${documentFilename(`payroll-${anchor}`)}.pdf`;

  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role: 'manager', requestId: crypto.randomUUID() },
      {
        action: 'export.payrollPdf',
        entityType: 'report',
        // Counts only — never names or per-person pay (PII-safe audit).
        metadata: {
          view,
          anchor,
          employeeCount: data.rows.length,
          shiftCount: data.totalShiftCount,
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
