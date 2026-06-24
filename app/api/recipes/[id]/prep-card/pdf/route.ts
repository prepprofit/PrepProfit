import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getOrgName, getUserId, getUserRole } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import {
  getRecipeWithIngredients,
  toKitchenRecipeWithIngredients,
} from '@/lib/data/recipes';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import {
  buildRecipePrepCardData,
  recipePrepCardFilename,
} from '@/lib/documents/recipe-prep-card-data';
import { buildRecipePrepCardLabels } from '@/lib/documents/recipe-prep-card-labels';
import { renderRecipePrepCardPdf } from '@/lib/documents/recipe-prep-card-pdf';
import { loadSafeLogo } from '@/lib/documents/logo';
import { documentFilename } from '@/lib/documents/format';
import { deriveScale } from '@/lib/calculations/recipeScale';
import { parseScaleParam } from '@/lib/validation/recipe-scale';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operational scaled prep-card PDF (Recipe scaling MVP) — a justified API route. The
 * prep card is MONEY-FREE (no cost/price/margin), so BOTH roles may download it; there
 * is no RBAC gate here (unlike the manager-only cost sheet at ../card/pdf). It is
 * org-scoped (RULE #1) — the org id is derived server-side and the read runs inside
 * `withOrg` so RLS is active — rate-limited (`documents` bucket), and audited
 * (`export.recipePrepCardPdf`) only after a successful render. A trashed or cross-org
 * recipe id returns 404. Optional `?portions=` scales the card; a malformed/out-of-
 * domain value returns 400 (never silently mis-scaled).
 *
 * The view-model is built from `toKitchenRecipeWithIngredients`, so the document is
 * money-free by TYPE — it can never carry a cost even by mistake.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const organizationId = await getOrgId();
  const userId = await getUserId();
  const role = await getUserRole();

  // Optional `?portions=` scaling — a malformed value is a 400. Missing = unscaled.
  const parsedScale = parseScaleParam(new URL(req.url).searchParams.get('portions'));
  if (!parsedScale.ok) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

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

  // Strip money BEFORE building the view-model (defense in depth + the builder takes
  // the kitchen shape).
  const operational = toKitchenRecipeWithIngredients(loaded.recipe);

  const scale =
    parsedScale.portions != null
      ? deriveScale(
          operational.recipe.yieldPortions,
          { kind: 'portions', targetPortions: parsedScale.portions },
          operational.lines.map((l) => l.quantity),
        )
      : null;
  if (scale && !scale.ok) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const t = await getTranslations('recipePrepCardDocument');
  const data = buildRecipePrepCardData(operational, settings, orgName, scale);
  // SSRF/DoS-safe: fetch + validate the logo ourselves and embed local bytes.
  data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

  const pdf = await renderRecipePrepCardPdf(data, buildRecipePrepCardLabels(t));
  const filename = `${documentFilename(recipePrepCardFilename(operational.recipe.name))}.pdf`;

  // Audit only now that the PDF rendered successfully (id only — no costs/scale value).
  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role, requestId: crypto.randomUUID() },
      {
        action: 'export.recipePrepCardPdf',
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
