import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getInvoiceImport } from '@/lib/data/supplier-invoice-imports';
import { loadInvoiceImpact } from '@/lib/data/invoice-impact';
import { listIngredientOptions } from '@/lib/data/ingredients';
import { getOrgSettingsRow } from '@/lib/data/org-settings';
import { NoAccess } from '@/components/app/no-access';
import { InvoiceReviewWorkbench } from './invoice-workbench';
import { InvoiceImpactCard } from './impact-card';

/**
 * Supplier invoice review workbench (Sprint 2). Manager-only (server + actions).
 * Loads the draft import + active ingredient options for the per-line match picker.
 * Applying records PENDING price observations only.
 */
export default async function SupplierInvoiceReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations('suppliers.invoices');

  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />;
  }

  const { id } = await params;
  const organizationId = await getOrgId();
  const { view, ingredientOptions, impact, orgCurrency } = await withOrg(
    organizationId,
    async (tx) => {
      const loaded = await getInvoiceImport(tx, organizationId, id);
      // Impact only exists once the import is applied (pending observations set).
      const projected =
        loaded?.header.status === 'applied'
          ? await loadInvoiceImpact(tx, organizationId, id)
          : null;
      const settings = await getOrgSettingsRow(tx, organizationId);
      return {
        view: loaded,
        ingredientOptions: await listIngredientOptions(tx, organizationId),
        impact: projected,
        orgCurrency: settings?.currency ?? 'EUR',
      };
    },
  );
  if (!view) notFound();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('review.subtitle')}</p>
      {impact && (
        <InvoiceImpactCard
          importId={id}
          currency={view.header.currencyCode ?? orgCurrency}
          impact={impact}
        />
      )}
      <InvoiceReviewWorkbench
        importId={id}
        header={{
          supplierNameRaw: view.header.supplierNameRaw,
          invoiceNumber: view.header.invoiceNumber,
          invoiceDate: view.header.invoiceDate,
          currencyCode: view.header.currencyCode,
          status: view.header.status,
        }}
        lines={view.lines.map((l) => ({
          id: l.id,
          rawText: l.rawText,
          itemNameRaw: l.itemNameRaw,
          matchedIngredientId: l.matchedIngredientId,
          quantityValue: l.quantityValue,
          quantityUnit: l.quantityUnit,
          packSizeValue: l.packSizeValue,
          packSizeUnit: l.packSizeUnit,
          unitPriceCents: l.unitPriceCents,
          status: l.status,
          issues: l.issues ?? [],
        }))}
        ingredientOptions={ingredientOptions}
      />
    </div>
  );
}
