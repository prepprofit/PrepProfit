'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import { parseMoneyToCents } from '@/lib/format/money';
import {
  postReceiptAction,
  voidReceiptAction,
  closePurchaseOrderAction,
} from '@/app/(app)/purchase-orders/receipt-actions';

export type ReceiveLine = {
  poItemId: string;
  ingredientName: string;
  unitLabel: string;
  orderedQuantity: number;
  receivedQuantity: number;
  defaultUnitCostCents: number;
};

export type ReceiptHistoryItem = {
  id: string;
  receivedDate: string;
  status: 'posted' | 'voided';
  lines: { ingredientName: string; receivedQuantity: number; unitLabel: string }[];
};

type LineDraft = { quantity: string; unitCost: string };

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Receiving panel for a sent / partially-received PO (Sprint 8b). Manager-only
 * (rendered only on the manager detail page). Posts a goods receipt (idempotent via a
 * client-minted mutation id), voids a posted receipt, and short-closes the PO. All
 * money/stock effects happen server-side; this island only collects input.
 */
export function ReceivePanel({
  poId,
  status,
  lines,
  receipts,
}: {
  poId: string;
  status: 'sent' | 'partially_received';
  lines: ReceiveLine[];
  receipts: ReceiptHistoryItem[];
}) {
  const t = useTranslations('purchaseOrders.receive');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  // A stable mutation id per receive attempt; rotated only after a successful post so
  // a retry/double-click reuses the same id (idempotent) but a new delivery is fresh.
  const mutationId = React.useRef(crypto.randomUUID());
  const [receivedDate, setReceivedDate] = React.useState(todayIso());
  const [drafts, setDrafts] = React.useState<Record<string, LineDraft>>({});
  const [confirmOver, setConfirmOver] = React.useState(false);
  const [closeOpen, setCloseOpen] = React.useState(false);
  const [closeReason, setCloseReason] = React.useState('');

  const draftFor = (line: ReceiveLine): LineDraft =>
    drafts[line.poItemId] ?? {
      quantity: '',
      unitCost: (line.defaultUnitCostCents / 100).toString(),
    };

  const setDraft = (poItemId: string, patch: Partial<LineDraft>) =>
    setDrafts((d) => ({
      ...d,
      [poItemId]: { ...(d[poItemId] ?? { quantity: '', unitCost: '' }), ...patch },
    }));

  const buildItems = () =>
    lines
      .map((line) => {
        const draft = draftFor(line);
        const qty = Number(draft.quantity);
        if (!Number.isFinite(qty) || qty <= 0) return null;
        return {
          line,
          qty,
          item: {
            purchaseOrderItemId: line.poItemId,
            receivedQuantity: qty,
            receivedUnitCostCents: parseMoneyToCents(draft.unitCost),
          },
        };
      })
      .filter((v): v is NonNullable<typeof v> => v != null);

  const hasOverDelivery = () =>
    buildItems().some(
      ({ line, qty }) => line.receivedQuantity + qty > line.orderedQuantity,
    );

  const submit = () => {
    const items = buildItems();
    if (items.length === 0) {
      setError(t('noLines'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await postReceiptAction({
        purchaseOrderId: poId,
        receivedDate,
        notes: null,
        clientMutationId: mutationId.current,
        items: items.map((i) => i.item),
      });
      if (result.ok) {
        mutationId.current = crypto.randomUUID();
        setDrafts({});
        router.refresh();
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const onPost = () => {
    if (buildItems().length === 0) {
      setError(t('noLines'));
      return;
    }
    if (hasOverDelivery()) {
      setConfirmOver(true);
      return;
    }
    submit();
  };

  const voidReceipt = (receiptId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await voidReceiptAction({ receiptId });
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  };

  const shortClose = () => {
    setCloseOpen(false);
    setError(null);
    startTransition(async () => {
      const result = await closePurchaseOrderAction({
        purchaseOrderId: poId,
        reason: closeReason,
      });
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            {t('date')}
            <input
              type="date"
              value={receivedDate}
              onChange={(e) => setReceivedDate(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">{t('ingredient')}</th>
              <th className="py-2 px-3 text-right font-semibold">{t('ordered')}</th>
              <th className="py-2 px-3 text-right font-semibold">{t('received')}</th>
              <th className="py-2 px-3 text-right font-semibold">{t('thisDelivery')}</th>
              <th className="py-2 pl-3 text-right font-semibold">{t('unitCost')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const draft = draftFor(line);
              const over =
                Number(draft.quantity) > 0 &&
                line.receivedQuantity + Number(draft.quantity) > line.orderedQuantity;
              return (
                <tr key={line.poItemId} className="border-b border-border">
                  <td className="py-2 pr-3 text-foreground">
                    {line.ingredientName}
                    {over && (
                      <Badge variant="warning" className="ml-2">
                        {t('over')}
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right text-muted-foreground">
                    {line.orderedQuantity} {line.unitLabel}
                  </td>
                  <td className="py-2 px-3 text-right text-muted-foreground">
                    {line.receivedQuantity} {line.unitLabel}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      aria-label={`${t('thisDelivery')} — ${line.ingredientName}`}
                      value={draft.quantity}
                      onChange={(e) => setDraft(line.poItemId, { quantity: e.target.value })}
                      className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right text-sm text-foreground"
                    />
                  </td>
                  <td className="py-2 pl-3 text-right">
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`${t('unitCost')} — ${line.ingredientName}`}
                      value={draft.unitCost}
                      onChange={(e) => setDraft(line.poItemId, { unitCost: e.target.value })}
                      className="w-24 rounded-md border border-border bg-background px-2 py-1 text-right text-sm text-foreground"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {error && (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </span>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {status === 'partially_received' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setCloseOpen(true)}
            >
              {t('shortClose')}
            </Button>
          )}
          <Button type="button" size="sm" disabled={pending} onClick={onPost}>
            {t('post')}
          </Button>
        </div>

        {receipts.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('history')}
            </h3>
            {receipts.map((r) => (
              <div
                key={r.id}
                className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {r.receivedDate}
                    {r.status === 'voided' && (
                      <Badge variant="neutral">{t('voided')}</Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.lines
                      .map((l) => `${l.ingredientName} ${l.receivedQuantity}${l.unitLabel}`)
                      .join(', ')}
                  </span>
                </div>
                {r.status === 'posted' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => voidReceipt(r.id)}
                  >
                    {t('void')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOver}
        title={t('overTitle')}
        description={t('overBody')}
        confirmLabel={t('post')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={() => {
          setConfirmOver(false);
          submit();
        }}
        onCancel={() => setConfirmOver(false)}
      />

      <ConfirmDialog
        open={closeOpen}
        title={t('shortCloseTitle')}
        description={t('shortCloseBody')}
        confirmLabel={t('shortClose')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={shortClose}
        onCancel={() => setCloseOpen(false)}
      >
        <input
          type="text"
          aria-label={t('reason')}
          placeholder={t('reason')}
          value={closeReason}
          onChange={(e) => setCloseReason(e.target.value)}
          className="mt-3 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        />
      </ConfirmDialog>
    </Card>
  );
}
