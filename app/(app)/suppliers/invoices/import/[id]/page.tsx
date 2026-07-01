import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getInvoiceImport } from '@/lib/data/supplier-invoice-imports';
import { listIngredientOptions } from '@/lib/data/ingredients';
import { NoAccess } from '@/components/app/no-access';
import { InvoiceReviewWorkbench } from './invoice-workbench';

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
  const [view, ingredientOptions] = await withOrg(organizationId, async (tx) => [
    await getInvoiceImport(tx, organizationId, id),
    await listIngredientOptions(tx, organizationId),
  ]);
  if (!view) notFound();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('review.subtitle')}</p>
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
