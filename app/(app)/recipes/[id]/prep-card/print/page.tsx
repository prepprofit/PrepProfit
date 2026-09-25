import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { getOrgId, getOrgName } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { listRecipePresets } from '@/lib/data/recipe-presets';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { buildKitchenScaleDocument } from '@/lib/kitchen-scale/prep-document';
import { basisCaption, buildRecipePrepCardData } from '@/lib/documents/recipe-prep-card-data';
import { buildRecipePrepCardLabels } from '@/lib/documents/recipe-prep-card-labels';
import { formatDocumentQuantity } from '@/lib/documents/format';
import {
  parsePrepCardBasisParam,
  parsePrepCardFactorParam,
} from '@/lib/validation/kitchen-scale-print';
import { Button } from '@/components/ui/button';
import { PrintButton } from '@/components/app/invoices/print-button';

// Always render fresh so the printed card reflects the latest recipe.
export const dynamic = 'force-dynamic';

function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') usp.set(key, value);
  }
  return usp;
}

/**
 * Print-friendly Kitchen Scale prep card (Kitchen Scale redesign §5).
 * MONEY-FREE (no cost, price, or margin), so BOTH roles may open it — there is
 * no `NoAccess` gate here (unlike the manager-only cost sheet at ../card/print).
 * Org-scoped; a trashed or cross-org id → notFound. Reuses the SAME
 * `buildRecipePrepCardData` money-free view-model as the PDF route, and the
 * SAME `?factor=` contract the Kitchen Scale calculator builds, so print and
 * download always render the exact applied calculation. An invalid `factor`
 * falls back to the unscaled card (mirrors the download route's 400).
 */
export default async function RecipePrepCardPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const rawSearchParams = await searchParams;
  const usp = toSearchParams(rawSearchParams);
  const organizationId = await getOrgId();

  const [loaded, t, tCard] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const dto = await getRecipeWorkspace(tx, organizationId, id, 'kitchen');
      if (!dto) return null;
      const settings = await getOrgSettingsRow(tx, organizationId);
      const presets = await listRecipePresets(tx, organizationId, id);
      return { dto, settings, presets };
    }),
    getTranslations('recipePrepCardDocument'),
    getTranslations('recipes.prepCard'),
  ]);

  if (!loaded) notFound();

  const doc = buildKitchenScaleDocument(loaded.dto);

  // Malformed `?factor=` falls back to unscaled — never a 500, never a guess.
  const parsedFactor = parsePrepCardFactorParam(usp.get('factor'));
  const factor = parsedFactor.ok ? (parsedFactor.factor ?? 1) : 1;
  const basisParam = parsedFactor.ok && parsedFactor.factor != null ? parsePrepCardBasisParam(usp) : null;
  const scaleQuery = parsedFactor.ok ? `?${usp.toString()}` : '';

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const labels = buildRecipePrepCardLabels(t);
  const data = buildRecipePrepCardData(
    doc,
    settings,
    orgName,
    factor,
    basisParam,
    loaded.presets.map((p) => ({ id: p.id, name: p.name, targetWeightGrams: p.targetWeightGrams })),
  );
  const { seller } = data;
  const paper = usp.get('paper') === 'letter' ? 'LETTER' : 'A4';
  const paperQuery = (p: 'a4' | 'letter') => {
    const next = new URLSearchParams(usp);
    next.set('paper', p);
    return `?${next.toString()}`;
  };
  const caption = basisCaption(data.basis, labels);

  return (
    <>
      {/* Suppress the app shell when printing — show only #recipe-prep-card-print. */}
      <style>{`@page { size: ${paper === 'LETTER' ? 'letter' : 'A4'}; margin: 15mm; }
      @media print {
        body * { visibility: hidden !important; }
        #recipe-prep-card-print, #recipe-prep-card-print * { visibility: visible !important; }
        #recipe-prep-card-print { position: absolute; left: 0; top: 0; width: 100%; }
      }`}</style>

      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/recipes/${id}`}>
              <ArrowLeft className="size-4" />
              {tCard('back')}
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" className="inline-flex items-center overflow-hidden rounded-lg border border-border text-xs">
              <Link
                href={paperQuery('a4')}
                aria-current={paper === 'A4' ? 'true' : undefined}
                className={`px-2.5 py-1.5 ${paper === 'A4' ? 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300' : 'text-muted-foreground hover:bg-surface-2'}`}
              >
                A4
              </Link>
              <Link
                href={paperQuery('letter')}
                aria-current={paper === 'LETTER' ? 'true' : undefined}
                className={`px-2.5 py-1.5 ${paper === 'LETTER' ? 'bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300' : 'text-muted-foreground hover:bg-surface-2'}`}
              >
                Letter
              </Link>
            </div>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/recipes/${id}/prep-card/pdf${scaleQuery}`}>{tCard('downloadPdf')}</a>
            </Button>
            <PrintButton label={tCard('print')} />
          </div>
        </div>

        <div
          id="recipe-prep-card-print"
          className="rounded-lg border border-border bg-white p-10 text-neutral-800 shadow-sm print:rounded-none print:border-0 print:shadow-none"
        >
          <p className="text-[8.5pt] text-neutral-500">{labels.brand(seller.name || null)}</p>
          <h1 className="mt-1 text-[27pt] font-bold leading-tight text-neutral-900">
            {data.recipeName}
          </h1>
          <p className="mt-1.5 text-[10pt] font-semibold text-[#096567]">{caption}</p>

          <table className="mt-5 w-full">
            <thead>
              <tr className="border-b border-neutral-900 text-left text-[8.5pt] font-semibold uppercase tracking-wide text-neutral-500">
                <th className="py-1.5 pr-3">{labels.ingredient}</th>
                <th className="py-1.5 pl-3 text-right">{labels.quantity}</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line, i) => (
                <tr key={i} className="border-b border-neutral-200">
                  <td className="py-2 pr-3 text-[18pt] text-neutral-900">
                    {line.name}
                    {line.isSubRecipe && (
                      <span className="ml-1.5 text-[10pt] text-neutral-500">{labels.subRecipe}</span>
                    )}
                  </td>
                  <td className="py-2 pl-3 text-right align-baseline">
                    <span className="text-[23pt] font-bold text-neutral-900">
                      {formatDocumentQuantity(line.quantity)}
                    </span>{' '}
                    <span className="text-[11pt] text-neutral-500">{labels.units[line.dimension]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.totalWeightGrams !== null && (
            <div className="mt-1 border-t border-neutral-900 pt-2">
              <div className="flex items-baseline justify-between">
                <span className="text-[12pt] font-bold text-neutral-900">{labels.totalToWeigh}</span>
                <span className="text-[16pt] font-bold text-neutral-900">
                  {formatDocumentQuantity(data.totalWeightGrams)} {labels.units.weight}
                </span>
              </div>
              {data.expectedFinishedWeightGrams !== null && (
                <div className="mt-1 flex items-baseline justify-between text-[9.5pt] text-neutral-500">
                  <span>{labels.expectedFinishedWeight}</span>
                  <span>
                    {formatDocumentQuantity(data.expectedFinishedWeightGrams)} {labels.units.weight}
                  </span>
                </div>
              )}
            </div>
          )}

          {(data.method.length > 0 || data.legacyNotes) && (
            <div className="mt-6">
              <h2 className="text-[12pt] font-bold uppercase tracking-wide text-[#096567]">
                {labels.method}
              </h2>
              {data.method.length > 0 ? (
                data.method.map((section, si) => (
                  <div key={si} className="mt-2.5">
                    {section.title && (
                      <h3 className="mb-1 text-[11pt] font-bold text-neutral-900">{section.title}</h3>
                    )}
                    <ol className="flex flex-col gap-1.5">
                      {section.steps.map((step, i) => (
                        <li key={i} className="flex gap-2 text-[10.5pt]">
                          <span className="font-bold text-[#096567]">{i + 1}.</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-[10.5pt]">{data.legacyNotes}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
