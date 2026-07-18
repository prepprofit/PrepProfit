import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getOrgId, getOrgName, getUserId, getUserRole } from '@/lib/auth';
import { getDb, withOrg } from '@/lib/db';
import { getRecipeById } from '@/lib/data/recipes';
import { resolveRecipeNutritionTree } from '@/lib/data/recipe-nutrition-tree';
import { loadRecipeAllergenRollup } from '@/lib/data/allergens';
import { getOrgSettingsRow } from '@/lib/data/org-settings';
import { writeAuditEvent } from '@/lib/data/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { nutritionLabelRows } from '@/lib/calculations/nutritionLabel';
import {
  renderNutritionLabelPdf,
  type NutritionLabelPdfRow,
} from '@/lib/documents/nutrition-label-pdf';
import { documentFilename } from '@/lib/documents/format';

// @react-pdf/renderer + the neon-serverless Pool need Node; never cache a download.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UNIT: Record<string, string> = {
  caloriesKcal: 'kcal',
  totalFatG: 'g',
  saturatedFatG: 'g',
  transFatG: 'g',
  cholesterolMg: 'mg',
  sodiumMg: 'mg',
  totalCarbohydrateG: 'g',
  dietaryFiberG: 'g',
  totalSugarsG: 'g',
  addedSugarsG: 'g',
  proteinG: 'g',
  vitaminDMcg: 'mcg',
  calciumMg: 'mg',
  ironMg: 'mg',
  potassiumMg: 'mg',
  caffeineMg: 'mg',
};
const INDENTED = new Set([
  'saturatedFatG',
  'transFatG',
  'dietaryFiberG',
  'totalSugarsG',
  'addedSugarsG',
]);

/**
 * Nutrition label PDF (Fase 6, plan §9.6) — MONEY-FREE, so BOTH roles may
 * download it (D5), like the prep card. Org-scoped (RULE #1, `withOrg`),
 * rate-limited (`documents` bucket) and audited (`export.nutritionLabelPdf`,
 * draft flag only) after a successful render. Requires a defined nutrition
 * serving (400 otherwise: without per-serving values there is nothing to
 * print — never a zeroed label). An incomplete rollup still renders,
 * watermarked `ESTIMATED / INCOMPLETE` (the "Print draft" path).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
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

  const { id } = await params;
  const loaded = await withOrg(organizationId, async (tx) => {
    const recipe = await getRecipeById(tx, organizationId, id);
    if (!recipe) return null;
    const [nutritionMap, allergens, settings] = await Promise.all([
      resolveRecipeNutritionTree(tx, organizationId, [id]),
      loadRecipeAllergenRollup(tx, organizationId, id),
      getOrgSettingsRow(tx, organizationId),
    ]);
    return {
      recipe,
      nutrition: nutritionMap.get(id) ?? null,
      allergens,
      settings,
    };
  });
  if (!loaded || !loaded.nutrition) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { result, servingGrams } = loaded.nutrition;
  if (!result.perServing) {
    // No nutrition serving defined → nothing printable (never a zeroed label).
    return NextResponse.json({ error: 'No nutrition serving' }, { status: 400 });
  }

  const t = await getTranslations('recipes.workspace.nutrition');
  const tAllergen = await getTranslations('allergens.labels');

  const rows: NutritionLabelPdfRow[] = nutritionLabelRows(result.perServing).map(
    (row) => ({
      label: t(`nutrients.${row.key}`),
      valueText:
        row.rounded === null
          ? null
          : `${row.lessThan ? '< ' : ''}${row.rounded} ${UNIT[row.key]}`,
      dvText: row.dvPercent === null ? null : `${row.dvPercent}%`,
      indent: INDENTED.has(row.key),
      bold: !INDENTED.has(row.key),
    }),
  );

  const contains = loaded.allergens.allergens
    .filter((a) => a.effectivePresence === 'contains')
    .map((a) => tAllergen(a.allergen));
  const mayContain = loaded.allergens.allergens
    .filter((a) => a.effectivePresence === 'may_contain')
    .map((a) => tAllergen(a.allergen));

  const orgName =
    loaded.settings?.businessName?.trim() || (await getOrgName()) || null;
  const draft = result.status !== 'complete';

  const pdf = await renderNutritionLabelPdf({
    recipeName: loaded.recipe.name,
    orgName,
    title: t('factsTitle'),
    servingText:
      servingGrams !== null
        ? t('servingSize', { grams: Math.round(servingGrams) })
        : t('servingUnknown'),
    rows,
    containsLabel: t('allergens.contains'),
    containsText: contains.length > 0 ? contains.join(', ') : null,
    mayContainLabel: t('allergens.mayContain'),
    mayContainText: mayContain.length > 0 ? mayContain.join(', ') : null,
    attribution: t('editor.attribution'),
    disclaimer: t('disclaimer'),
    watermark: draft ? t('watermark') : null,
  });

  await withOrg(organizationId, (tx) =>
    writeAuditEvent(
      tx,
      organizationId,
      { userId, role, requestId: crypto.randomUUID() },
      {
        action: 'export.nutritionLabelPdf',
        entityType: 'recipe',
        entityId: id,
        metadata: { draft },
      },
    ),
  );

  const filename = `${documentFilename(`${loaded.recipe.name}-nutrition-label`)}.pdf`;
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

