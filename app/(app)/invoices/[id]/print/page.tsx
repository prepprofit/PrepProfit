import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { canAccessFinancials, getOrgId, getOrgName, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getInvoiceWithItems } from '@/lib/data/invoices';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { buildInvoiceDocumentData } from '@/lib/documents/invoice-data';
import { buildInvoiceLabels } from '@/lib/documents/invoice-labels';
import { formatMoney, formatDocDate } from '@/lib/documents/format';
import { Button } from '@/components/ui/button';
import { NoAccess } from '@/components/app/no-access';
import { PrintButton } from '@/components/app/invoices/print-button';
import { PrintLogo } from '@/components/app/invoices/print-logo';

// Always render fresh so the printed document reflects the latest invoice state.
export const dynamic = 'force-dynamic';

/**
 * Print-friendly invoice view (Sprint 3.5A). Manager-only and org-scoped, it
 * reuses the SAME `buildInvoiceDocumentData` view-model as the PDF route so the
 * two never drift. The toolbar is hidden when printing (`print:hidden`); an inline
 * print stylesheet uses the visibility trick to suppress the app shell (sidebar)
 * so only the document prints, without coupling to the layout's markup.
 */
export default async function InvoicePrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const { id } = await params;
  const organizationId = await getOrgId();

  const [loaded, t, tDetail] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const detail = await getInvoiceWithItems(tx, organizationId, id);
      if (!detail) return null;
      const settings = await getOrgSettingsRow(tx, organizationId);
      return { detail, settings };
    }),
    getTranslations('invoiceDocument'),
    getTranslations('invoices.detail'),
  ]);

  if (!loaded) notFound();

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  // Only round-trip to Clerk for the org name when there is no business name.
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const labels = buildInvoiceLabels(t);
  const data = buildInvoiceDocumentData(loaded.detail, settings, orgName);
  const money = (cents: number) => formatMoney(cents, data.currency);
  const { seller, customer } = data;

  return (
    <>
      {/* Suppress the app shell when printing — show only #invoice-print. */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #invoice-print, #invoice-print * { visibility: visible !important; }
        #invoice-print { position: absolute; left: 0; top: 0; width: 100%; }
      }`}</style>

      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3 print:hidden">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/invoices/${id}`}>
              <ArrowLeft className="size-4" />
              {tDetail('back')}
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={`/api/invoices/${id}/pdf`}>{tDetail('downloadPdf')}</a>
            </Button>
            <PrintButton label={tDetail('print')} />
          </div>
        </div>

        <div
          id="invoice-print"
          className="rounded-lg border border-border bg-white p-10 text-sm text-neutral-800 shadow-sm print:rounded-none print:border-0 print:shadow-none"
        >
          {/* Header: seller + document meta */}
          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-0.5">
              {seller.logoUrl && <PrintLogo src={seller.logoUrl} alt={seller.name} />}
              <span className="text-lg font-semibold text-neutral-900">
                {seller.name}
              </span>
              {seller.address && (
                <span className="text-neutral-500">{seller.address}</span>
              )}
              {seller.taxId && (
                <span className="text-neutral-500">
                  {labels.taxId}: {seller.taxId}
                </span>
              )}
              {seller.email && (
                <span className="text-neutral-500">{seller.email}</span>
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-2xl font-bold tracking-wide text-[#c2410c]">
                {labels.title}
              </span>
              {data.number && (
                <span className="font-semibold text-neutral-900">
                  {labels.invoiceNo} {data.number}
                </span>
              )}
              <span className="mt-1 rounded border border-[#c2410c] px-2 py-0.5 text-xs font-semibold uppercase text-[#c2410c]">
                {labels.status[data.status]}
              </span>
            </div>
          </div>

          {/* Parties + dates */}
          <div className="mt-8 flex items-start justify-between gap-6">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {labels.billTo}
              </span>
              <span className="font-semibold text-neutral-900">
                {customer.name ?? ''}
              </span>
              {customer.taxId && (
                <span className="text-neutral-500">
                  {labels.taxId}: {customer.taxId}
                </span>
              )}
              {customer.address && (
                <span className="text-neutral-500">{customer.address}</span>
              )}
              {customer.email && (
                <span className="text-neutral-500">{customer.email}</span>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5 text-neutral-600">
              {data.issueDate && (
                <span>
                  {labels.issued}: {formatDocDate(data.issueDate)}
                </span>
              )}
              {data.dueDate && (
                <span>
                  {labels.due}: {formatDocDate(data.dueDate)}
                </span>
              )}
            </div>
          </div>

          {/* Line items */}
          <table className="mt-8 w-full">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-2 pr-3 font-semibold">{labels.description}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.quantity}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.unitPrice}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.taxRate}</th>
                <th className="py-2 pl-3 text-right font-semibold">{labels.lineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line, i) => (
                <tr key={i} className="border-b border-neutral-200">
                  <td className="py-2 pr-3 text-neutral-800">{line.description}</td>
                  <td className="py-2 px-3 text-right text-neutral-600">{line.quantity}</td>
                  <td className="py-2 px-3 text-right text-neutral-600">
                    {money(line.unitPriceCents)}
                  </td>
                  <td className="py-2 px-3 text-right text-neutral-600">
                    {line.taxRatePercent}%
                  </td>
                  <td className="py-2 pl-3 text-right font-medium text-neutral-900">
                    {money(line.grossCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="ml-auto mt-6 flex w-56 flex-col gap-1">
            <div className="flex justify-between text-neutral-600">
              <span>{labels.subtotal}</span>
              <span>{money(data.subtotalCents)}</span>
            </div>
            <div className="flex justify-between text-neutral-600">
              <span>{labels.tax}</span>
              <span>{money(data.taxCents)}</span>
            </div>
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
