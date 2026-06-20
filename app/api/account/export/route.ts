import { NextResponse } from 'next/server';
import { getOrgId, getUserId, isManager } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import {
  buildOrgDataExport,
  countExportRows,
} from '@/lib/data/account-export';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';

// neon-serverless Pool needs Node; force-dynamic so the download is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GDPR org data export (Sprint 5e): a manager downloads a JSON bundle of every
 * business table the org owns (data portability / access request). Canonical order:
 * RBAC (403) -> rate-limit (429) -> withOrg load + post-success audit -> stream.
 * RULE #1: the org id is derived from Clerk server-side; the build runs inside
 * `withOrg` so RLS scopes every read. Read-only — it deletes nothing.
 */
export async function GET(): Promise<NextResponse> {
  if (!(await isManager())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const organizationId = await getOrgId();
  const userId = await getUserId();

  // Abuse control: heaviest read in the app, so a tight per-org+user budget.
  const limit = await enforceRateLimit(
    getDb(),
    'accountExport',
    `${organizationId}:${userId}`,
  );
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const bundle = await withOrg(organizationId, async (tx) => {
    const exported = await buildOrgDataExport(tx, organizationId);
    // Audit AFTER a successful build: who exported, how many rows total. No data,
    // no PII — just a count.
    await writeAuditEvent(
      tx,
      organizationId,
      { userId, role: 'manager', requestId: crypto.randomUUID() },
      {
        action: 'account.export',
        entityType: 'organization',
        entityId: organizationId,
        metadata: { rowCount: countExportRows(exported) },
      },
    );
    return exported;
  });

  const filename = `prepprofit-export-${organizationId}-${
    bundle.exportedAt.split('T')[0]
  }.json`;

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
