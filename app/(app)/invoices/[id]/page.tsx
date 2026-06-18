import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft, Download, Printer } from 'lucide-react';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { getInvoiceWithItems } from '@/lib/data/invoices';
import { lineTotals } from '@/lib/calculations/invoice';
import { formatMoney } from '@/lib/format/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NoAccess } from '@/components/app/no-access';

const STATUS_VARIANT = {
  draft: 'neutral',
  issued: 'accent',
  paid: 'positive',
  void: 'neutral',
} as const;

/**
 * On-screen invoice preview (the printable/PDF document is Sprint 3.5). Read-only,
 * manager-only, org-scoped. Shows the frozen customer snapshot + line items + the
 * totals exactly as stored.
 */
export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const t = await getTranslations('invoices');
  const { id } = await params;
  const organizationId = await getOrgId();

  const [detail, settings] = await Promise.all([
    withOrg(organizationId, (tx) => getInvoiceWithItems(tx, organizationId, id)),
    getOrgSettings(),
  ]);
  if (!detail) notFound();

  const { invoice, items } = detail;
  const currency = settings.currency;
  const billedTo =
    invoice.customerName ?? invoice.customerEmail ?? t('list.noCustomer');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/invoices">
            <ArrowLeft className="size-4" />
            {t('detail.back')}
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/invoices/${id}/print`}>
              <Printer className="size-4" />
              {t('detail.print')}
            </Link>
          </Button>
          <Button asChild size="sm">
            <a href={`/api/invoices/${id}/pdf`}>
              <Download className="size-4" />
              {t('detail.downloadPdf')}
            </a>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-6 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="font-display text-xl font-semibold text-foreground">
                {invoice.number ?? t('detail.title')}
              </h1>
              <Badge variant={STATUS_VARIANT[invoice.status]}>
                {t(`status.${invoice.status}`)}
              </Badge>
            </div>
            <div className="flex flex-col gap-0.5 text-right text-sm text-muted-foreground">
              {invoice.issueDate && (
                <span>
                  {t('detail.issuedOn')}: {invoice.issueDate}
                </span>
              )}
              {invoice.dueDate && (
                <span>
                  {t('detail.dueOn')}: {invoice.dueDate}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('detail.billedTo')}
            </span>
            <span className="font-medium text-foreground">{billedTo}</span>
            {invoice.customerTaxId && (
              <span className="text-muted-foreground">{invoice.customerTaxId}</span>
            )}
            {invoice.customerAddress && (
              <span className="text-muted-foreground">{invoice.customerAddress}</span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('builder.description')}</th>
                  <th className="py-2 px-3 text-right font-medium">
                    {t('builder.quantity')}
                  </th>
                  <th className="py-2 px-3 text-right font-medium">
                    {t('builder.unitPrice')}
                  </th>
                  <th className="py-2 px-3 text-right font-medium">
                    {t('builder.taxRate')}
                  </th>
                  <th className="py-2 pl-3 text-right font-medium">
                    {t('builder.lineTotal')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((it) => {
                  const lt = lineTotals({
                    quantity: Number(it.quantity),
                    unitPriceCents: it.unitPriceCents,
                    taxRate: Number(it.taxRate),
                  });
                  return (
                    <tr key={it.id}>
                      <td className="py-2 pr-3 text-foreground">{it.description}</td>
                      <td className="py-2 px-3 text-right text-muted-foreground">
                        {Number(it.quantity)}
                      </td>
                      <td className="py-2 px-3 text-right text-muted-foreground">
                        {formatMoney(it.unitPriceCents, currency)}
                      </td>
                      <td className="py-2 px-3 text-right text-muted-foreground">
                        {Number(it.taxRate)}%
                      </td>
                      <td className="py-2 pl-3 text-right font-medium text-foreground">
                        {formatMoney(lt.grossCents, currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="ml-auto flex w-full max-w-xs flex-col gap-1 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>{t('builder.subtotal')}</span>
              <span>{formatMoney(invoice.subtotalCents, currency)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{t('builder.tax')}</span>
              <span>{formatMoney(invoice.taxCents, currency)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1 text-base font-semibold text-foreground">
              <span>{t('builder.grandTotal')}</span>
              <span>{formatMoney(invoice.totalCents, currency)}</span>
            </div>
          </div>

          {invoice.notes && (
            <p className="text-sm text-muted-foreground">{invoice.notes}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
