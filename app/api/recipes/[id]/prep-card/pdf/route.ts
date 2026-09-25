import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getOrgName, getUserId, getUserRole } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { listRecipePresets } from '@/lib/data/recipe-presets';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { buildKitchenScaleDocument } from '@/lib/kitchen-scale/prep-document';
import {
  buildRecipePrepCardData,
  recipePrepCardFilename,
} from '@/lib/documents/recipe-prep-card-data';
import { buildRecipePrepCardLabels } from '@/lib/documents/recipe-prep-card-labels';
import { renderRecipePrepCardPdf } from '@/lib/documents/recipe-prep-card-pdf';
import { documentFilename } from '@/lib/documents/format';
import {
  parsePrepCardBasisParam,
  parsePrepCardFactorParam,
} from '@/lib/validation/kitchen-scale-print';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Kitchen Scale prep-card PDF (Kitchen Scale redesign §5) — a justified API
 * route. The prep card is MONEY-FREE (no cost/price/margin), so BOTH roles may
 * download it; there is no RBAC gate here (unlike the manager-only cost sheet
 * at ../card/pdf). It is org-scoped (RULE #1) — the org id is derived server-side
 * and the read runs inside `withOrg` so RLS is active — rate-limited
 * (`documents` bucket), and audited (`export.recipePrepCardPdf`) only after a
 * successful render. A trashed or cross-org recipe id returns 404.
 *
 * Takes the SAME `?factor=...&basis=...` contract the Kitchen Scale calculator
 * builds (see `lib/validation/kitchen-scale-print.ts`): the exact multiplier the
 * on-screen calculation already derived, re-applied to the recipe's ORIGINAL
 * quantities — never a value reconstructed from a rounded intermediate — so the
 * downloaded PDF always matches the print page and the calculator exactly. A
 * malformed/out-of-domain `factor` returns 400.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const organizationId = await getOrgId();
  const userId = await getUserId();
  const role = await getUserRole();
  const url = new URL(req.url);

  const parsedFactor = parsePrepCardFactorParam(url.searchParams.get('factor'));
  if (!parsedFactor.ok) {
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
    const dto = await getRecipeWorkspace(tx, organizationId, id, 'kitchen');
    if (!dto) return null;
    const settings = await getOrgSettingsRow(tx, organizationId);
    const presets = await listRecipePresets(tx, organizationId, id);
    return { dto, settings, presets };
  });

  if (!loaded) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const doc = buildKitchenScaleDocument(loaded.dto);
  const factor = parsedFactor.factor ?? 1;
  const basisParam =
    parsedFactor.factor != null ? parsePrepCardBasisParam(url.searchParams) : null;

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const t = await getTranslations('recipePrepCardDocument');
  const data = buildRecipePrepCardData(
    doc,
    settings,
    orgName,
    factor,
    basisParam,
    loaded.presets.map((p) => ({ id: p.id, name: p.name, targetWeightGrams: p.targetWeightGrams })),
  );

  const paper = url.searchParams.get('paper') === 'letter' ? 'LETTER' : 'A4';
  const pdf = await renderRecipePrepCardPdf(data, buildRecipePrepCardLabels(t), paper);
  const filename = `${documentFilename(recipePrepCardFilename(doc.name))}.pdf`;

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
