import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getOrgName, getUserId, getUserRole } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { loadRecipeFinishedWeights } from '@/lib/data/recipe-yield';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { buildRecipeDocument } from '@/lib/recipes/recipe-document';
import { renderRecipePrintPdf } from '@/lib/documents/recipe-print-pdf';
import { loadSafeLogo } from '@/lib/documents/logo';
import { documentFilename } from '@/lib/documents/format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Print-ready recipe PDF (recipe list "Print"). MONEY-FREE by construction — built
 * from the KITCHEN workspace shape — so both roles may open it. Org-scoped under
 * `withOrg` (RULE #1), rate-limited (`documents`), audited after a successful render,
 * and served inline so the browser opens it ready to print. Trashed / other-org → 404.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const organizationId = await getOrgId();
  const userId = await getUserId();
  const role = await getUserRole();

  const limit = await enforceRateLimit(getDb(), 'documents', `${organizationId}:${userId}`);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const { id } = await params;
  const loaded = await withOrg(organizationId, async (tx) => {
    const dto = await getRecipeWorkspace(tx, organizationId, id, 'kitchen');
    if (!dto) return null;
    const weights = await loadRecipeFinishedWeights(tx, organizationId, [dto.recipe]);
    const settings = await getOrgSettingsRow(tx, organizationId);
    return { doc: buildRecipeDocument(dto, weights.get(dto.recipe.id) ?? null), settings };
  });
  if (!loaded) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const sellerName = settings.businessName?.trim() || (await getOrgName()) || '';
  const t = await getTranslations('recipePrintDocument');
  const pdf = await renderRecipePrintPdf(
    loaded.doc,
    {
      makes: t('makes'),
      finishedWeight: t('finishedWeight'),
      yield: t('yield'),
      ingredients: t('ingredients'),
      amount: t('amount'),
      subRecipe: t('subRecipe'),
      method: t('method'),
      noMethod: t('noMethod'),
      footer: t('footer'),
    },
    { name: sellerName, logoUrl: await loadSafeLogo(settings.businessLogoUrl ?? null) },
  );

  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role, requestId: crypto.randomUUID() },
      { action: 'export.recipePrintPdf', entityType: 'recipe', entityId: id },
    ),
  );

  const filename = `${documentFilename(loaded.doc.name)}.pdf`;
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
