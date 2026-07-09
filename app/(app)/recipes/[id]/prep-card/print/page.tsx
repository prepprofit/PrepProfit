import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { getOrgId, getOrgName } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  getRecipeWithIngredients,
  toKitchenRecipeWithIngredients,
} from '@/lib/data/recipes';
import { listRecipeComponents } from '@/lib/data/recipe-components';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { buildRecipePrepCardData } from '@/lib/documents/recipe-prep-card-data';
import { buildRecipePrepCardLabels } from '@/lib/documents/recipe-prep-card-labels';
import { deriveScale } from '@/lib/calculations/recipeScale';
import { parseScaleParam } from '@/lib/validation/recipe-scale';
import { Button } from '@/components/ui/button';
import { PrintButton } from '@/components/app/invoices/print-button';
import { PrintLogo } from '@/components/app/invoices/print-logo';

// Always render fresh so the printed card reflects the latest recipe.
export const dynamic = 'force-dynamic';

/**
 * Print-friendly operational prep card (Recipe scaling MVP). MONEY-FREE (no cost,
 * price, or margin), so BOTH roles may open it — there is no `NoAccess` gate here
 * (unlike the manager-only cost sheet at ../card/print). Org-scoped; a trashed or
 * cross-org id → notFound. Reuses the SAME `buildRecipePrepCardData` money-free
 * view-model as the PDF route. Optional `?portions=` scales the card; an invalid
 * value falls back to the unscaled card (and the download link mirrors that).
 */
export default async function RecipePrepCardPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ portions?: string | string[] }>;
}) {
  const { id } = await params;
  const { portions: rawPortions } = await searchParams;
  const organizationId = await getOrgId();

  const [loaded, t, tCard] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const recipe = await getRecipeWithIngredients(tx, organizationId, id);
      if (!recipe) return null;
      const settings = await getOrgSettingsRow(tx, organizationId);
      // Sub-recipe component lines — name + grams only (money-free surface).
      const components = (
        await listRecipeComponents(tx, organizationId, [id])
      ).map((c) => ({ name: c.componentName, quantityGrams: c.quantityGrams }));
      return { recipe, settings, components };
    }),
    getTranslations('recipePrepCardDocument'),
    getTranslations('recipes.prepCard'),
  ]);

  if (!loaded) notFound();

  const operational = toKitchenRecipeWithIngredients(loaded.recipe);

  // Optional `?portions=` scaling — an invalid/over-range value falls back to unscaled.
  const parsedScale = parseScaleParam(rawPortions);
  const scale =
    parsedScale.ok && parsedScale.portions != null
      ? deriveScale(
          operational.recipe.yieldPortions,
          { kind: 'portions', targetPortions: parsedScale.portions },
          operational.lines.map((l) => l.quantity),
        )
      : null;
  const appliedPortions =
    scale && scale.ok ? (parsedScale.ok ? parsedScale.portions : null) : null;
  const scaleQuery = appliedPortions != null ? `?portions=${appliedPortions}` : '';

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const labels = buildRecipePrepCardLabels(t);
  const data = buildRecipePrepCardData(
    operational,
    settings,
    orgName,
    scale,
    loaded.components,
  );
  const { seller } = data;

  return (
    <>
      {/* Suppress the app shell when printing — show only #recipe-prep-card-print. */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #recipe-prep-card-print, #recipe-prep-card-print * { visibility: visible !important; }
        #recipe-prep-card-print { position: absolute; left: 0; top: 0; width: 100%; }
      }`}</style>

      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3 print:hidden">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/recipes/${id}`}>
              <ArrowLeft className="size-4" />
              {tCard('back')}
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={`/api/recipes/${id}/prep-card/pdf${scaleQuery}`}>
                {tCard('downloadPdf')}
              </a>
            </Button>
            <PrintButton label={tCard('print')} />
          </div>
        </div>

        <div
          id="recipe-prep-card-print"
          className="rounded-lg border border-border bg-white p-10 text-sm text-neutral-800 shadow-sm print:rounded-none print:border-0 print:shadow-none"
        >
          {/* Header: seller branding + recipe meta */}
          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-0.5">
              {seller.logoUrl && <PrintLogo src={seller.logoUrl} alt={seller.name} />}
              {seller.name !== '' && (
                <span className="text-base font-semibold text-neutral-900">
                  {seller.name}
                </span>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-xl font-bold tracking-wide text-[#c2410c]">
                {labels.title}
              </span>
              <span className="text-base font-semibold text-neutral-900">
                {data.recipeName}
              </span>
              <span className="text-neutral-500">
                {labels.yield}: {data.yieldPortions} {labels.portions} ·{' '}
                {labels.usableYield} {data.yieldPercentage}%
              </span>
              {data.scale && (
                <span className="font-semibold text-[#c2410c]">
                  {labels.scaledTo({
                    portions: String(data.scale.scaledPortions),
                    factor: String(data.scale.factor),
                  })}
                </span>
              )}
            </div>
          </div>

          {/* Ingredient lines — quantities only, no cost column */}
          <table className="mt-8 w-full">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-2 pr-3 font-semibold">{labels.ingredient}</th>
                <th className="py-2 pl-3 text-right font-semibold">{labels.quantity}</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line, i) => (
                <tr key={i} className="border-b border-neutral-200">
                  <td className="py-2 pr-3 text-neutral-800">{line.name}</td>
                  <td className="py-2 pl-3 text-right text-neutral-600">
                    {line.quantity} {labels.units[line.dimension]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Sub-recipe component lines — finished grams only, money-free */}
          {data.components.length > 0 && (
            <table className="mt-6 w-full">
              <thead>
                <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-3 font-semibold">{labels.subRecipes}</th>
                  <th className="py-2 pl-3 text-right font-semibold">
                    {labels.quantity}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.components.map((line, i) => (
                  <tr key={i} className="border-b border-neutral-200">
                    <td className="py-2 pr-3 text-neutral-800">{line.name}</td>
                    <td className="py-2 pl-3 text-right text-neutral-600">
                      {line.quantityGrams} {labels.units.weight}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data.notes && (
            <p className="mt-8 text-xs text-neutral-500">
              {labels.notes}: {data.notes}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
