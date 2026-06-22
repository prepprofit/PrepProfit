import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { canAccessFinancials, getOrgId, getOrgName, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  getPurchaseOrderWithItems,
  loadPurchaseOrderLiveContext,
} from '@/lib/data/purchase-orders';
import {
  listReceiptsForPurchaseOrder,
  receivedRollup,
} from '@/lib/data/receipts';
import { listOutboxForDocument } from '@/lib/data/email-outbox';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { buildPurchaseOrderDocumentData } from '@/lib/documents/po-data';
import { buildPurchaseOrderLabels } from '@/lib/documents/po-labels';
import { formatMoney, formatDocDate } from '@/lib/documents/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { NoAccess } from '@/components/app/no-access';
import { PoCancelButton } from '@/components/app/purchase-orders/po-cancel-button';
import {
  ReceivePanel,
  type ReceiveLine,
  type ReceiptHistoryItem,
} from '@/components/app/purchase-orders/receive-panel';
import type { EmailOutboxStatus } from '@/lib/db/schema';
import type { Dimension } from '@/lib/units';

const UNIT: Record<Dimension, string> = { weight: 'g', volume: 'ml', count: '×' };

// Always render fresh so the detail reflects the latest PO + outbox state.
export const dynamic = 'force-dynamic';

/**
 * Purchase-order detail (Sprint 8a). Manager-only and org-scoped. Drafts are edited
 * inline on the list page, so a draft id redirects there; this page is the read-only
 * record for a SENT/CANCELLED order, with the frozen snapshot, the email-outbox
 * status, and Download/Print/Cancel.
 */
export default async function PurchaseOrderDetailPage({
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
      const outbox = await listOutboxForDocument(
        tx,
        organizationId,
        'purchase_order',
        id,
      );
      const canReceive =
        detail.order.status === 'sent' ||
        detail.order.status === 'partially_received';
      const receiptHistory = canReceive
        ? await listReceiptsForPurchaseOrder(tx, organizationId, id)
        : [];
      const rollup = canReceive
        ? await receivedRollup(tx, organizationId, id)
        : new Map<string, number>();
      return { detail, settings, live, outbox, receiptHistory, rollup };
    }),
    getTranslations('purchaseOrderDocument'),
    getTranslations('purchaseOrders.detail'),
  ]);

  if (!loaded) notFound();
  // Drafts are edited inline on the list page.
  if (loaded.detail.order.status === 'draft') redirect('/purchase-orders');

  const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = settings.businessName?.trim() ? null : await getOrgName();
  const labels = buildPurchaseOrderLabels(tDoc);
  const data = buildPurchaseOrderDocumentData(loaded.detail, settings, orgName, loaded.live);
  const money = (cents: number) => formatMoney(cents, data.currency);

  // The most recent outbox row drives the status chip.
  const latestOutbox = loaded.outbox[0];
  const outboxKey: EmailOutboxStatus | 'none' = latestOutbox?.status ?? 'none';

  const orderStatus = loaded.detail.order.status;
  const canReceive =
    orderStatus === 'sent' || orderStatus === 'partially_received';
  const receiveLines: ReceiveLine[] = canReceive
    ? loaded.detail.items.map((item) => ({
        poItemId: item.id,
        ingredientName: item.ingredientName ?? '',
        unitLabel: item.dimension ? UNIT[item.dimension] : '',
        orderedQuantity: Number(item.quantity),
        receivedQuantity: loaded.rollup.get(item.id) ?? 0,
        defaultUnitCostCents: item.unitCostCents,
      }))
    : [];
  const receiptHistory: ReceiptHistoryItem[] = loaded.receiptHistory.map((r) => ({
    id: r.receipt.id,
    receivedDate: r.receipt.receivedDate,
    status: r.receipt.status,
    lines: r.items.map((it) => ({
      ingredientName: it.ingredientName,
      receivedQuantity: Number(it.receivedQuantity),
      unitLabel: it.dimension ? UNIT[it.dimension] : '',
    })),
  }));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/purchase-orders">
            <ArrowLeft className="size-4" />
            {t('back')}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral">{t(`outbox.${outboxKey}`)}</Badge>
          <Button asChild variant="outline" size="sm">
            <a href={`/api/purchase-orders/${id}/pdf`}>{t('downloadPdf')}</a>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/purchase-orders/${id}/print`}>{t('print')}</Link>
          </Button>
          {loaded.detail.order.status === 'sent' && <PoCancelButton id={id} />}
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-6 py-6">
          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-0.5">
              <span className="text-lg font-semibold text-foreground">
                {data.seller.name}
              </span>
              {data.seller.address && (
                <span className="text-sm text-muted-foreground">{data.seller.address}</span>
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-xl font-bold tracking-wide text-accent-foreground">
                {labels.title}
              </span>
              <span className="font-semibold text-foreground">
                {labels.poNo} {data.number}
              </span>
              <Badge variant={data.status === 'sent' ? 'accent' : 'neutral'}>
                {labels.status[data.status]}
              </Badge>
            </div>
          </div>

          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {labels.supplierTo}
              </span>
              <span className="font-medium text-foreground">{data.supplier.name ?? ''}</span>
              {data.supplier.email && (
                <span className="text-sm text-muted-foreground">{data.supplier.email}</span>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5 text-sm text-muted-foreground">
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

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">{labels.ingredient}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.quantity}</th>
                <th className="py-2 px-3 text-right font-semibold">{labels.unitCost}</th>
                <th className="py-2 pl-3 text-right font-semibold">{labels.lineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line, i) => (
                <tr key={i} className="border-b border-border">
                  <td className="py-2 pr-3 text-foreground">{line.name}</td>
                  <td className="py-2 px-3 text-right text-muted-foreground">
                    {line.quantity} {labels.units[line.dimension]}
                  </td>
                  <td className="py-2 px-3 text-right text-muted-foreground">
                    {money(line.unitCostCents)}
                  </td>
                  <td className="py-2 pl-3 text-right font-medium text-foreground">
                    {money(line.lineTotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="ml-auto flex w-56 flex-col gap-1">
            <div className="flex justify-between border-t border-border pt-1 text-base font-bold text-foreground">
              <span>{labels.total}</span>
              <span>{money(data.totalCents)}</span>
            </div>
          </div>

          {data.notes && (
            <p className="text-xs text-muted-foreground">
              {labels.notes}: {data.notes}
            </p>
          )}
        </CardContent>
      </Card>

      {canReceive && (
        <ReceivePanel
          poId={id}
          status={orderStatus as 'sent' | 'partially_received'}
          lines={receiveLines}
          receipts={receiptHistory}
        />
      )}
    </div>
  );
}
