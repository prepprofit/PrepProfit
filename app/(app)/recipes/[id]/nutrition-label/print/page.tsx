import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getRecipeById } from '@/lib/data/recipes';
import { resolveRecipeNutritionTree } from '@/lib/data/recipe-nutrition-tree';
import { loadRecipeAllergenRollup } from '@/lib/data/allergens';
import { nutritionLabelRows } from '@/lib/calculations/nutritionLabel';
import type { NutrientKey } from '@/lib/calculations/nutrition';
import { Button } from '@/components/ui/button';
import { PrintButton } from '@/components/app/invoices/print-button';

// Always render fresh so the printed label reflects the latest recipe.
export const dynamic = 'force-dynamic';

const UNIT: Record<NutrientKey, string> = {
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
const INDENTED = new Set<NutrientKey>([
  'saturatedFatG',
  'transFatG',
  'dietaryFiberG',
  'totalSugarsG',
  'addedSugarsG',
]);

/**
 * Print-friendly nutrition label (Fase 6, plan §9.6). MONEY-FREE, so BOTH
 * roles may open it (D5) — no NoAccess gate, like the prep card. Org-scoped;
 * cross-org/trashed id → notFound; a recipe without a nutrition serving shows
 * the actionable notice instead of a zeroed label. Incomplete rollups print
 * with the `ESTIMATED / INCOMPLETE` watermark and everything carries the
 * estimate disclaimer + USDA attribution (never a compliance claim).
 */
export default async function NutritionLabelPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = await getOrgId();

  const [loaded, t, tAllergen] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const recipe = await getRecipeById(tx, organizationId, id);
      if (!recipe) return null;
      const [nutritionMap, allergens] = await Promise.all([
        resolveRecipeNutritionTree(tx, organizationId, [id]),
        loadRecipeAllergenRollup(tx, organizationId, id),
      ]);
      return { recipe, nutrition: nutritionMap.get(id) ?? null, allergens };
    }),
    getTranslations('recipes.workspace.nutrition'),
    getTranslations('allergens.labels'),
  ]);
  if (!loaded || !loaded.nutrition) notFound();

  const { result, servingGrams } = loaded.nutrition;
  const rows = result.perServing ? nutritionLabelRows(result.perServing) : null;
  const draft = result.status !== 'complete';
  const contains = loaded.allergens.allergens
    .filter((a) => a.effectivePresence === 'contains')
    .map((a) => tAllergen(a.allergen));
  const mayContain = loaded.allergens.allergens
    .filter((a) => a.effectivePresence === 'may_contain')
    .map((a) => tAllergen(a.allergen));

  return (
    <>
      {/* Suppress the app shell when printing — show only #nutrition-label-print. */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #nutrition-label-print, #nutrition-label-print * { visibility: visible !important; }
        #nutrition-label-print { position: absolute; left: 0; top: 0; width: 100%; }
      }`}</style>

      <div className="mx-auto flex max-w-xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3 print:hidden">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/recipes/${id}?tab=nutrition`}>
              <ArrowLeft className="size-4" />
              {loaded.recipe.name}
            </Link>
          </Button>
          {rows ? (
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={`/api/recipes/${id}/nutrition-label/pdf`}>
                  {draft ? t('printDraft') : t('print')} (PDF)
                </a>
              </Button>
              <PrintButton label={draft ? t('printDraft') : t('print')} />
            </div>
          ) : null}
        </div>

        <div
          id="nutrition-label-print"
          className="relative rounded-lg border border-border bg-white p-10 text-sm text-neutral-800 shadow-sm print:rounded-none print:border-0 print:shadow-none"
        >
          {draft ? (
            <p className="pointer-events-none absolute inset-x-0 top-1/2 -rotate-12 text-center text-4xl font-extrabold uppercase tracking-widest text-red-600/25">
              {t('watermark')}
            </p>
          ) : null}
          <p className="text-base font-semibold text-neutral-900">
            {loaded.recipe.name}
          </p>

          {rows ? (
            <div className="mt-4 max-w-sm border-2 border-neutral-900 p-3">
              <p className="text-2xl font-extrabold leading-tight text-neutral-900">
                {t('factsTitle')}
              </p>
              <p className="border-b-8 border-neutral-900 pb-1 text-xs text-neutral-500">
                {servingGrams !== null
                  ? t('servingSize', { grams: Math.round(servingGrams) })
                  : t('servingUnknown')}
              </p>
              <table className="w-full">
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className="border-b border-neutral-200 last:border-b-0">
                      <td
                        className={`py-0.5 ${INDENTED.has(row.key) ? 'pl-4' : 'font-medium'}`}
                      >
                        {t(`nutrients.${row.key}`)}
                      </td>
                      <td className="py-0.5 text-right tabular-nums">
                        {row.rounded === null
                          ? '—'
                          : `${row.lessThan ? '< ' : ''}${row.rounded} ${UNIT[row.key]}`}
                      </td>
                      <td className="w-12 py-0.5 text-right tabular-nums text-neutral-500">
                        {row.dvPercent === null ? '' : `${row.dvPercent}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-4 text-neutral-600">
              {t('issueGeneric.NO_NUTRITION_SERVING')}
            </p>
          )}

          <div className="mt-4 max-w-sm text-xs">
            <p>
              <span className="font-semibold">{t('allergens.contains')}: </span>
              {contains.length > 0 ? contains.join(', ') : '—'}
            </p>
            <p>
              <span className="font-semibold">{t('allergens.mayContain')}: </span>
              {mayContain.length > 0 ? mayContain.join(', ') : '—'}
            </p>
          </div>

          <div className="mt-4 max-w-sm text-[10px] leading-snug text-neutral-500">
            <p>{t('editor.attribution')}</p>
            <p>
              {t('editor.attributionOff')} — {t('editor.attributionOffLicense')}
            </p>
            <p>{t('disclaimer')}</p>
          </div>
        </div>
      </div>
    </>
  );
}
