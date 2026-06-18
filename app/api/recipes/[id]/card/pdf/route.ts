import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getOrgName, getUserId, getUserRole } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { getRecipeWithIngredients } from '@/lib/data/recipes';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import {
  buildRecipeCardData,
  recipeCardFilename,
} from '@/lib/documents/recipe-card-data';
import { buildRecipeCardLabels } from '@/lib/documents/recipe-card-labels';
import { renderRecipeCardPdf } from '@/lib/documents/recipe-card-pdf';
import { loadSafeLogo } from '@/lib/documents/logo';
import { documentFilename } from '@/lib/documents/format';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Recipe card (cost sheet) PDF download (Sprint 3.5B) — a justified API route.
 * Unlike the financial documents this is NOT manager-only: the recipe editor
 * already shows the same live cost + margin to kitchen, so the card exposes nothing
 * new. It is still org-scoped (RULE #1) — the org id is derived server-side and the
 * read runs inside `withOrg` so RLS is active — rate-limited (`documents` bucket),
 * and audited (`export.recipeCardPdf`) only after a successful render. A trashed or
 * cross-org recipe id returns 404 (never leaks existence).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Recipes are visible to every role; no manager gate. Resolve the actor for
  // rate limiting + audit (any authenticated org member).
  const organizationId = await getOrgId();
  const userId = await getUserId();
  const role = await getUserRole();

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

  // Load only (no audit here): the export is audited AFTER a successful render.
  const loaded = await withOrg(organizationId, async (tx) => {
    const recipe = await getRecipeWithIngredients(tx, organizationId, id);
    if (!recipe) return null;
    const settings = await getOrgSettingsRow(tx, organizationId);
    return { recipe, settings };
  });

  if (!loaded) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const t = await getTranslations('recipeCardDocument');
  const data = buildRecipeCardData(loaded.recipe, settings, orgName);
  // SSRF/DoS-safe: fetch + validate the logo ourselves and embed local bytes.
  data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

  const pdf = await renderRecipeCardPdf(data, buildRecipeCardLabels(t));
  const filename = `${documentFilename(recipeCardFilename(loaded.recipe.recipe.name))}.pdf`;

  // Audit only now that the PDF rendered successfully (id only — no costs/margins).
  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role, requestId: crypto.randomUUID() },
      {
        action: 'export.recipeCardPdf',
        entityType: 'recipe',
        entityId: id,
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
