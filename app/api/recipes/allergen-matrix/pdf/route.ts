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
import { renderAllergenMatrixPdf } from '@/lib/documents/allergen-matrix-pdf';
import { loadSafeLogo } from '@/lib/documents/logo';
import { documentFilename } from '@/lib/documents/format';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Kitchen allergen matrix PDF (Sprint 9) — OPERATIONAL and KITCHEN-VISIBLE. Unlike
 * the recipe cost card it carries NO money, so there is NO manager gate: any
 * authenticated org member may download it. RULE #1: org id derived server-side, the
 * read runs inside `withOrg` so RLS is active; rate-limited (`documents` bucket) and
 * audited (`export.allergenMatrixPdf`, recipe count only) after a successful render.
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
  // SSRF/DoS-safe: fetch + validate the logo ourselves and embed local bytes.
  data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

  const pdf = await renderAllergenMatrixPdf(data, buildAllergenMatrixLabels(doc, names));
  const filename = `${documentFilename(allergenMatrixFilename())}.pdf`;

  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role, requestId: crypto.randomUUID() },
      {
        action: 'export.allergenMatrixPdf',
        entityType: 'recipe',
        entityId: null,
        metadata: { recipeCount: data.rows.length },
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
