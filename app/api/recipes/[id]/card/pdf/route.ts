import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import {
  canSeeRecipeCosts,
  getOrgId,
  getOrgName,
  getUserId,
  getUserRole,
} from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { getRecipeWithIngredients } from '@/lib/data/recipes';
import { listRecipeComponents } from '@/lib/data/recipe-components';
import { resolveRecipeCostTree } from '@/lib/data/recipe-cost-tree';
import { componentRawCostCents } from '@/lib/calculations/recipeCost';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import {
  buildRecipeCardData,
  recipeCardFilename,
} from '@/lib/documents/recipe-card-data';
import { buildRecipeCardLabels } from '@/lib/documents/recipe-card-labels';
import { renderRecipeCardPdf } from '@/lib/documents/recipe-card-pdf';
import { deriveScale } from '@/lib/calculations/recipeScale';
import { parseScaleParam } from '@/lib/validation/recipe-scale';
import { loadSafeLogo } from '@/lib/documents/logo';
import { documentFilename } from '@/lib/documents/format';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Recipe card (cost sheet) PDF download (Sprint 3.5B; MANAGER-ONLY since F4) — a
 * justified API route. The card is entirely cost + margin + selling price, so a
 * non-manager (kitchen, who sees no money) gets 403 before any data access. It is
 * org-scoped (RULE #1) — the org id is derived server-side and the read runs inside
 * `withOrg` so RLS is active — rate-limited (`documents` bucket), and audited
 * (`export.recipeCardPdf`) only after a successful render. A trashed or cross-org
 * recipe id returns 404 (never leaks existence).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const organizationId = await getOrgId();
  const userId = await getUserId();
  const role = await getUserRole();

  // The cost sheet is financial — managers only (Sprint F4). Refuse before any work.
  if (!canSeeRecipeCosts(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Optional `?portions=` scaling — a malformed value is a 400 (never silently
  // mis-scaled). Missing = unscaled.
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
    // Sub-recipe component lines with their resolved raw material cost.
    const componentLines = await listRecipeComponents(tx, organizationId, [id]);
    const resolutions = await resolveRecipeCostTree(
      tx,
      organizationId,
      componentLines.map((c) => c.componentRecipeId),
    );
    const components = componentLines.map((c) => {
      const resolution = resolutions.get(c.componentRecipeId);
      return {
        name: c.componentName,
        quantityGrams: c.quantityGrams,
        rawCostCents: resolution?.complete
          ? componentRawCostCents(
              resolution.cost.totalCostCents,
              c.quantityGrams,
              c.componentYieldWeightGrams,
            )
          : null,
      };
    });
    return { recipe, settings, components };
  });

  if (!loaded) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Derive the scale now that we have the recipe; an out-of-domain factor
  // (overflowing line) is a 400 too.
  const scale =
    parsedScale.portions != null
      ? deriveScale(
          loaded.recipe.recipe.yieldPortions,
          { kind: 'portions', targetPortions: parsedScale.portions },
          loaded.recipe.lines.map((l) => l.quantity),
        )
      : null;
  if (scale && !scale.ok) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const t = await getTranslations('recipeCardDocument');
  const data = buildRecipeCardData(
    loaded.recipe,
    settings,
    orgName,
    scale,
    loaded.components,
  );
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
