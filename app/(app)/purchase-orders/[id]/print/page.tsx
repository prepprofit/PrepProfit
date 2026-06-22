import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { canAccessFinancials, getOrgId, getOrgName, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  getPurchaseOrderWithItems,
  loadPurchaseOrderLiveContext,
} from '@/lib/data/purchase-orders';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { buildPurchaseOrderDocumentData } from '@/lib/documents/po-data';
import { buildPurchaseOrderLabels } from '@/lib/documents/po-labels';
import { formatMoney, formatDocDate } from '@/lib/documents/format';
import { Button } from '@/components/ui/button';
import { NoAccess } from '@/components/app/no-access';
import { PrintButton } from '@/components/app/invoices/print-button';
import { PrintLogo } from '@/components/app/invoices/print-logo';

// Always render fresh so the printed document reflects the latest PO state.
export const dynamic = 'force-dynamic';

/**
 * Print-friendly purchase-order view (Sprint 8a). Manager-only and org-scoped, it
 * reuses the SAME `buildPurchaseOrderDocumentData` view-model as the PDF route so the
 * two never drift. A draft renders live data + a "DRAFT" marker. The toolbar is
 * hidden when printing; an inline print stylesheet suppresses the app shell.
 */
export default async function PurchaseOrderPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const { id } = await params;
  const organizationId = await getOrgId();

  const [loaded, tDoc, t] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const detail = await getPurchaseOrderWithItems(tx, organizationId, id);
      if (!detail) return null;
      const settings = await getOrgSettingsRow(tx, organizationId);
      const live = await loadPurchaseOrderLiveContext(tx, organizationId, detail);
      return { detail, settings, live };
    }),
    getTranslations('purchaseOrderDocument'),
    getTranslations('purchaseOrders.detail'),
  ]);

  if (!loaded) notFound();

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const labels = buildPurchaseOrderLabels(tDoc);
  const data = buildPurchaseOrderDocumentData(loaded.detail, settings, orgName, loaded.live);
  const money = (cents: number) => formatMoney(cents, data.currency);
  const { seller, supplier } = data;

  return (
    <>
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #po-print, #po-print * { visibility: visible !important; }
        #po-print { position: absolute; left: 0; top: 0; width: 100%; }
      }`}</style>

      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3 print:hidden">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/purchase-orders/${id}`}>
              <ArrowLeft className="size-4" />
              {t('back')}
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={`/api/purchase-orders/${id}/pdf`}>{t('downloadPdf')}</a>
            </Button>
            <PrintButton label={t('print')} />
          </div>
        </div>

        <div
          id="po-print"
          className="rounded-lg border border-border bg-white p-10 text-sm text-neutral-800 shadow-sm print:rounded-none print:border-0 print:shadow-none"
        >
          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-0.5">
              {seller.logoUrl && <PrintLogo src={seller.logoUrl} alt={seller.name} />}
              <span className="text-lg font-semibold text-neutral-900">{seller.name}</span>
              {seller.address && <span className="text-neutral-500">{seller.address}</span>}
              {seller.taxId && (
                <span className="text-neutral-500">
                  {labels.taxId}: {seller.taxId}
                </span>
              )}
              {seller.email && <span className="text-neutral-500">{seller.email}</span>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-2xl font-bold tracking-wide text-[#c2410c]">
                {labels.title}
              </span>
              <span className="font-semibold text-neutral-900">
                {labels.poNo} {data.number}
              </span>
              <span className="mt-1 rounded border border-[#c2410c] px-2 py-0.5 text-xs font-semibold uppercase text-[#c2410c]">
                {labels.status[data.status]}
              </span>
            </div>
          </div>

          <div className="mt-8 flex items-start justify-between gap-6">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {labels.supplierTo}
              </span>
              <span className="font-semibold text-neutral-900">{supplier.name ?? ''}</span>
              {supplier.taxId && (
                <span className="text-neutral-500">
                  {labels.taxId}: {supplier.taxId}
                </span>
              )}
              {supplier.address && <span className="text-neutral-500">{supplier.address}</span>}
              {supplier.email && <span className="text-neutral-500">{supplier.email}</span>}
              {supplier.phone && (
                <span className="text-neutral-500">
                  {labels.phone}: {supplier.phone}
                </span>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5 text-neutral-600">
              {data.orderDate && (
                <span>
                  {labels.orderDate}: {formatDocDate(data.orderDate)}
                </span>
              )}
              {data.expectedDate && (
                <span>
                  {labels.expectedDate}: {formatDocDate(data.expectedDate)}
                </span>
              )}
            </div>
          </div>

          <table className="mt-8 w-full">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-2 pr-3 font-semibold">{labels.ingredient}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.quantity}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.unitCost}</th>
                <th className="py-2 pl-3 text-right font-semibold">{labels.lineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line, i) => (
                <tr key={i} className="border-b border-neutral-200">
                  <td className="py-2 pr-3 text-neutral-800">{line.name}</td>
                  <td className="py-2 px-3 text-right text-neutral-600">
                    {line.quantity} {labels.units[line.dimension]}
                  </td>
                  <td className="py-2 px-3 text-right text-neutral-600">
                    {money(line.unitCostCents)}
                  </td>
                  <td className="py-2 pl-3 text-right font-medium text-neutral-900">
                    {money(line.lineTotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="ml-auto mt-6 flex w-56 flex-col gap-1">
            <div className="flex justify-between border-t border-neutral-800 pt-1 text-base font-bold text-neutral-900">
              <span>{labels.total}</span>
              <span>{money(data.totalCents)}</span>
            </div>
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
