import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { getOrgId, getOrgName, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getRecipeWithIngredients } from '@/lib/data/recipes';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { buildRecipeCardData } from '@/lib/documents/recipe-card-data';
import { buildRecipeCardLabels } from '@/lib/documents/recipe-card-labels';
import { formatMoney } from '@/lib/documents/format';
import { Button } from '@/components/ui/button';
import { PrintButton } from '@/components/app/invoices/print-button';
import { PrintLogo } from '@/components/app/invoices/print-logo';
import { SendDocumentDialog } from '@/components/app/send-document-dialog';
import { NoAccess } from '@/components/app/no-access';

// Always render fresh so the printed card reflects the latest recipe + prices.
export const dynamic = 'force-dynamic';

/**
 * Print-friendly recipe card / cost sheet (Sprint 3.5B; MANAGER-ONLY since F4). The
 * card is entirely cost + margin + selling price, so kitchen — which sees no money —
 * is blocked here (renders NoAccess) just like the PDF route returns 403. Org-scoped;
 * a trashed or cross-org id → notFound. Reuses the SAME `buildRecipeCardData`
 * view-model as the PDF route so the two never drift.
 */
export default async function RecipeCardPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // The cost sheet is financial — managers only (Sprint F4). Kitchen is blocked
  // before any data access.
  if (!(await isManager())) {
    return <NoAccess />;
  }

  const { id } = await params;
  const organizationId = await getOrgId();

  const [loaded, t, tCard] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const recipe = await getRecipeWithIngredients(tx, organizationId, id);
      if (!recipe) return null;
      const settings = await getOrgSettingsRow(tx, organizationId);
      return { recipe, settings };
    }),
    getTranslations('recipeCardDocument'),
    getTranslations('recipes.card'),
  ]);

  if (!loaded) notFound();

  // Emailing is manager-only too; the trigger is always shown here now.
  const canEmail = true;

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const labels = buildRecipeCardLabels(t);
  const data = buildRecipeCardData(loaded.recipe, settings, orgName);
  const money = (cents: number) => formatMoney(cents, data.currency);
  const { seller } = data;

  return (
    <>
      {/* Suppress the app shell when printing — show only #recipe-card-print. */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #recipe-card-print, #recipe-card-print * { visibility: visible !important; }
        #recipe-card-print { position: absolute; left: 0; top: 0; width: 100%; }
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
              <a href={`/api/recipes/${id}/card/pdf`}>{tCard('downloadPdf')}</a>
            </Button>
            <PrintButton label={tCard('print')} />
            {canEmail && (
              <SendDocumentDialog doc={{ documentType: 'recipeCard', recipeId: id }} />
            )}
          </div>
        </div>

        <div
          id="recipe-card-print"
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
            </div>
          </div>

          {/* Ingredient lines */}
          <table className="mt-8 w-full">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-2 pr-3 font-semibold">{labels.ingredient}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.quantity}</th>
                <th className="py-2 pl-3 text-right font-semibold">{labels.cost}</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line, i) => (
                <tr key={i} className="border-b border-neutral-200">
                  <td className="py-2 pr-3 text-neutral-800">{line.name}</td>
                  <td className="py-2 px-3 text-right text-neutral-600">
                    {line.quantity} {labels.units[line.dimension]}
                  </td>
                  <td className="py-2 pl-3 text-right font-medium text-neutral-900">
                    {money(line.costCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Cost breakdown + margin */}
          <div className="ml-auto mt-6 flex w-64 flex-col gap-1">
            <div className="flex justify-between text-neutral-600">
              <span>{labels.ingredientCost}</span>
              <span>{money(data.ingredientCostCents)}</span>
            </div>
            <div className="flex justify-between text-neutral-600">
              <span>{labels.labor}</span>
              <span>{money(data.laborCostCents)}</span>
            </div>
            <div className="flex justify-between text-neutral-600">
              <span>{labels.energy}</span>
              <span>{money(data.energyCostCents)}</span>
            </div>
            <div className="flex justify-between text-neutral-600">
              <span>{labels.packaging}</span>
              <span>{money(data.packagingCostCents)}</span>
            </div>
            <div className="flex justify-between border-t border-neutral-800 pt-1 text-base font-bold text-neutral-900">
              <span>{labels.totalCost}</span>
              <span>{money(data.totalCostCents)}</span>
            </div>
            <div className="flex justify-between text-neutral-600">
              <span>{labels.costPerPortion}</span>
              <span>{money(data.costPerPortionCents)}</span>
            </div>
            {data.sellingPriceCents != null && (
              <div className="flex justify-between text-neutral-600">
                <span>{labels.sellingPrice}</span>
                <span>{money(data.sellingPriceCents)}</span>
              </div>
            )}
            {data.marginPercent != null && (
              <div className="mt-1 flex justify-between font-semibold text-[#c2410c]">
                <span>{labels.margin}</span>
                <span>{data.marginPercent}%</span>
              </div>
            )}
          </div>

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
