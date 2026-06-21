import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getOrgName, getUserId, getUserRole } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { loadOrgRecipeAllergens } from '@/lib/data/allergens';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import {
  buildAllergenMatrixData,
  allergenMatrixFilename,
} from '@/lib/documents/allergen-matrix-data';
import { buildAllergenMatrixLabels } from '@/lib/documents/allergen-matrix-labels';
import { renderAllergenMatrixXlsx } from '@/lib/documents/allergen-matrix-xlsx';
import { documentFilename } from '@/lib/documents/format';

// write-excel-file (Node build) + the neon-serverless Pool need Node.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Kitchen allergen matrix XLSX (Sprint 9) — OPERATIONAL, KITCHEN-VISIBLE, money-free
 * (no manager gate). Mirrors the PDF route: org-scoped read under `withOrg`,
 * rate-limited, audited (`export.allergenMatrixXlsx`, recipe count only) after a
 * successful render. The logo is not embedded in a spreadsheet.
 */
export async function GET(): Promise<NextResponse> {
  const organizationId = await getOrgId();
  const userId = await getUserId();
  const role = await getUserRole();

  const limit = await enforceRateLimit(
    getDb(),
    'documents',
    `${organizationId}:${userId}`,
  );
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const loaded = await withOrg(organizationId, async (tx) => {
    const summaries = await loadOrgRecipeAllergens(tx, organizationId);
    const settings = await getOrgSettingsRow(tx, organizationId);
    return { summaries, settings };
  });

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const [doc, names] = await Promise.all([
    getTranslations('allergenMatrixDocument'),
    getTranslations('allergens.labels'),
  ]);

  const generatedOn = new Date().toISOString().slice(0, 10);
  const data = buildAllergenMatrixData(loaded.summaries, settings, orgName, generatedOn);

  const xlsx = await renderAllergenMatrixXlsx(data, buildAllergenMatrixLabels(doc, names));
  const filename = `${documentFilename(allergenMatrixFilename())}.xlsx`;

  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role, requestId: crypto.randomUUID() },
      {
        action: 'export.allergenMatrixXlsx',
        entityType: 'recipe',
        entityId: null,
        metadata: { recipeCount: data.rows.length },
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
