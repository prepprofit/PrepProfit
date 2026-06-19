import { NextResponse } from 'next/server';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { enforceRateLimit } from '@/lib/rate-limit';
import { importParamsSchema } from '@/lib/validation/import';
import {
  buildCsvTemplate,
  buildXlsxTemplate,
  templateFilename,
} from '@/lib/import/templates';

// neon-serverless Pool + write-excel-file need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Import template download (Sprint 4.5). A file download → justified Route Handler
 * (CLAUDE.md). Manager-only and rate-limited like the other download routes. The
 * template is STATIC content (no tenant data is read), so there is no `withOrg`
 * and no audit event — only the entity/format selection is validated server-side.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!(await isManager())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Org + user only scope the rate-limit key (RULE #1: derived server-side).
  const organizationId = await getOrgId();
  const userId = await getUserId();
  const limit = await enforceRateLimit(
    getDb(),
    'import',
    `${organizationId}:${userId}`,
  );
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const parsed = importParamsSchema.safeParse({
    entity: searchParams.get('entity'),
    format: searchParams.get('format'),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid selection' }, { status: 400 });
  }
  const { entity, format } = parsed.data;
  const filename = templateFilename(entity, format);

  if (format === 'csv') {
    return new NextResponse(buildCsvTemplate(entity), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const buffer = await buildXlsxTemplate(entity);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
