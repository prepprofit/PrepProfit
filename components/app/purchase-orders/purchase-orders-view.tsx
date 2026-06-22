'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ClipboardList, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  formatMoney,
  parseMoneyToCents,
  centsToAmountInput,
} from '@/lib/format/money';
import {
  purchaseOrderLineTotalCents,
  purchaseOrderTotals,
} from '@/lib/calculations/purchaseOrder';
import type { Dimension } from '@/lib/units';
import type { PurchaseOrderStatus } from '@/lib/db/schema';
import type { ActionResult } from '@/lib/action-result';
import {
  cancelPurchaseOrderAction,
  createPurchaseOrderAction,
  deletePurchaseOrderAction,
  sendPurchaseOrderAction,
  updatePurchaseOrderAction,
} from '@/app/(app)/purchase-orders/actions';

export type SupplierOption = { id: string; name: string };
export type IngredientOption = {
  id: string;
  name: string;
  dimension: Dimension;
  /** Approved cost per priced unit, the default for a new line's unit cost. */
  priceCents: number;
};

export type PurchaseOrderRow = {
  id: string;
  number: number;
  status: PurchaseOrderStatus;
  supplierName: string | null;
  totalCents: number;
  orderDate: string | null;
};

/** A draft's editable contents, so the builder can load it in place. */
export type DraftDetail = {
  id: string;
  supplierId: string;
  expectedDate: string;
  notes: string;
  lines: LineState[];
};

type LineState = { ingredientId: string; quantity: string; unitCost: string };

const STATUS_VARIANT: Record<PurchaseOrderStatus, 'neutral' | 'accent'> = {
  draft: 'neutral',
  sent: 'accent',
  cancelled: 'neutral',
};

const UNIT: Record<Dimension, string> = { weight: 'g', volume: 'ml', count: '×' };

const emptyLine = (): LineState => ({ ingredientId: '', quantity: '', unitCost: '' });

const formatPo = (n: number) => `PO-${String(n).padStart(4, '0')}`;

export function PurchaseOrdersView({
  currency,
  suppliers,
  ingredients,
  orders,
  drafts,
}: {
  currency: string;
  suppliers: SupplierOption[];
  ingredients: IngredientOption[];
  orders: PurchaseOrderRow[];
  drafts: Record<string, DraftDetail>;
}) {
  const actionError = useActionError();
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(
    (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => {
      setError(null);
      startTransition(async () => {
        const result = await fn();
        if (result.ok) {
          after?.();
          router.refresh();
        } else {
          setError(actionError(result.code));
        }
      });
    },
    [actionError, router],
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <PurchaseOrderBuilder
        currency={currency}
        suppliers={suppliers}
        ingredients={ingredients}
        drafts={drafts}
        pending={pending}
        run={run}
        setError={setError}
      />

      <PurchaseOrderList
        currency={currency}
        orders={orders}
        pending={pending}
        run={run}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

function PurchaseOrderBuilder({
  currency,
  suppliers,
  ingredients,
  drafts,
  pending,
  run,
  setError,
}: {
  currency: string;
  suppliers: SupplierOption[];
  ingredients: IngredientOption[];
  drafts: Record<string, DraftDetail>;
  pending: boolean;
  run: (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => void;
  setError: (msg: string | null) => void;
}) {
  const t = useTranslations('purchaseOrders.builder');
  const tRoot = useTranslations('purchaseOrders');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [supplierId, setSupplierId] = React.useState('');
  const [expectedDate, setExpectedDate] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<LineState[]>([emptyLine()]);

  const ingredientById = React.useMemo(() => {
    const map = new Map<string, IngredientOption>();
    for (const ing of ingredients) map.set(ing.id, ing);
    return map;
  }, [ingredients]);

  React.useEffect(() => {
    const onEdit = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const draft = drafts[id];
      if (!draft) return;
      setEditingId(draft.id);
      setSupplierId(draft.supplierId);
      setExpectedDate(draft.expectedDate);
      setNotes(draft.notes);
      setLines(draft.lines.length > 0 ? draft.lines : [emptyLine()]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('pp-edit-po', onEdit);
    return () => window.removeEventListener('pp-edit-po', onEdit);
  }, [drafts]);

  const reset = () => {
    setEditingId(null);
    setSupplierId('');
    setExpectedDate('');
    setNotes('');
    setLines([emptyLine()]);
  };

  const updateLine = (index: number, patch: Partial<LineState>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  // Selecting an ingredient prefills the unit cost from its approved cost.
  const pickIngredient = (index: number, ingredientId: string) => {
    const ing = ingredientById.get(ingredientId);
    setLines((prev) =>
      prev.map((l, i) =>
        i === index
          ? {
              ...l,
              ingredientId,
              unitCost:
                l.unitCost === '' && ing
                  ? centsToAmountInput(ing.priceCents)
                  : l.unitCost,
            }
          : l,
      ),
    );
  };

  const addLine = () => setLines((prev) => [...prev, emptyLine()]);
  const removeLine = (index: number) =>
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));

  const buildItems = () =>
    lines
      .filter((l) => l.ingredientId !== '' && Number(l.quantity) > 0)
      .map((l) => ({
        ingredientId: l.ingredientId,
        quantity: Number(l.quantity) || 0,
        unitCostCents: parseMoneyToCents(l.unitCost),
      }));

  // Live subtotal preview.
  const previewTotals = purchaseOrderTotals(
    lines
      .filter((l) => l.ingredientId !== '')
      .map((l) => {
        const dim = ingredientById.get(l.ingredientId)?.dimension ?? 'weight';
        return {
          dimension: dim,
          unitCostCents: parseMoneyToCents(l.unitCost),
          quantity: Number(l.quantity) || 0,
        };
      }),
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const items = buildItems();
    if (items.length === 0) {
      setError(t('lineIncomplete'));
      return;
    }
    const payload = {
      supplierId: supplierId || null,
      expectedDate: expectedDate || null,
      notes,
      items,
    };
    run(
      () =>
        editingId
          ? updatePurchaseOrderAction(editingId, payload)
          : createPurchaseOrderAction(payload),
      reset,
    );
  };

  if (suppliers.length === 0) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-sm text-muted-foreground">{tRoot('noSuppliers')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editingId ? t('editTitle') : t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="po-supplier">{t('supplier')}</Label>
              <Select
                id="po-supplier"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">{t('selectSupplier')}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="po-expected">{t('expectedDate')}</Label>
              <Input
                id="po-expected"
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="po-notes">{t('notes')}</Label>
              <Input
                id="po-notes"
                placeholder={t('notesPlaceholder')}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t('lines')}</Label>
            <div className="flex flex-col gap-2">
              {lines.map((line, index) => {
                const dim = ingredientById.get(line.ingredientId)?.dimension;
                const lt = purchaseOrderLineTotalCents({
                  dimension: dim ?? 'weight',
                  unitCostCents: parseMoneyToCents(line.unitCost),
                  quantity: Number(line.quantity) || 0,
                });
                return (
                  <div
                    key={index}
                    className="grid grid-cols-1 items-end gap-2 rounded-lg border border-border bg-surface-2 p-3 sm:grid-cols-[1fr_7rem_8rem_5rem_auto]"
                  >
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`po-ing-${index}`} className="text-xs">
                        {t('ingredient')}
                      </Label>
                      <Select
                        id={`po-ing-${index}`}
                        value={line.ingredientId}
                        onChange={(e) => pickIngredient(index, e.target.value)}
                      >
                        <option value="">{t('selectIngredient')}</option>
                        {ingredients.map((ing) => (
                          <option key={ing.id} value={ing.id}>
                            {ing.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`po-qty-${index}`} className="text-xs">
                        {t('quantity')}
                        {dim ? ` (${UNIT[dim]})` : ''}
                      </Label>
                      <Input
                        id={`po-qty-${index}`}
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(e) => updateLine(index, { quantity: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`po-cost-${index}`} className="text-xs">
                        {t('unitCost')}
                      </Label>
                      <Input
                        id={`po-cost-${index}`}
                        inputMode="decimal"
                        placeholder="0.00"
                        value={line.unitCost}
                        onChange={(e) => updateLine(index, { unitCost: e.target.value })}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-end">
                      <span className="text-sm font-medium text-foreground">
                        {formatMoney(lt, currency)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t('removeLine')}
                        disabled={pending || lines.length === 1}
                        onClick={() => removeLine(index)}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={addLine}>
                <Plus className="size-4" />
                {t('addLine')}
              </Button>
            </div>
          </div>

          <div className="ml-auto flex w-full max-w-xs flex-col gap-1 text-sm">
            <div className="flex justify-between border-t border-border pt-1 font-semibold text-foreground">
              <span>{t('total')}</span>
              <span>{formatMoney(previewTotals.totalCents, currency)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending}>
              <ClipboardList className="size-4" />
              {editingId ? t('saveChanges') : t('saveDraft')}
            </Button>
            {editingId && (
              <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
                {t('cancelEdit')}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* List                                                                        */
/* -------------------------------------------------------------------------- */

function PurchaseOrderList({
  currency,
  orders,
  pending,
  run,
}: {
  currency: string;
  orders: PurchaseOrderRow[];
  pending: boolean;
  run: (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => void;
}) {
  const t = useTranslations('purchaseOrders');
  const tList = useTranslations('purchaseOrders.list');
  const tStatus = useTranslations('purchaseOrders.status');
  const tActions = useTranslations('purchaseOrders.actions');
  const tCommon = useTranslations('common');

  const [sendTarget, setSendTarget] = React.useState<PurchaseOrderRow | null>(null);
  const [cancelTarget, setCancelTarget] = React.useState<PurchaseOrderRow | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<PurchaseOrderRow | null>(null);

  const editDraft = (id: string) => {
    window.dispatchEvent(new CustomEvent('pp-edit-po', { detail: id }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tList('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {orders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-10 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {orders.map((po) => (
              <li
                key={po.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[po.status]}>
                      {tStatus(po.status)}
                    </Badge>
                    <span className="text-sm font-medium text-foreground">
                      {formatPo(po.number)}
                    </span>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {po.supplierName ?? tList('noSupplier')}
                    {po.orderDate ? ` · ${po.orderDate}` : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">
                    {formatMoney(po.totalCents, currency)}
                  </span>
                  {po.status === 'draft' && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => editDraft(po.id)}
                      >
                        <Pencil className="size-4" />
                        {tActions('edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => setSendTarget(po)}
                      >
                        <Send className="size-4" />
                        {tActions('send')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={tActions('delete')}
                        disabled={pending}
                        onClick={() => setDeleteTarget(po)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                  {po.status !== 'draft' && (
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/purchase-orders/${po.id}`}>{tActions('view')}</Link>
                    </Button>
                  )}
                  {po.status === 'sent' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => setCancelTarget(po)}
                    >
                      {tActions('cancel')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={sendTarget !== null}
        title={tActions('sendTitle')}
        description={tActions('sendBody')}
        confirmLabel={tActions('send')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={() => {
          if (sendTarget) run(() => sendPurchaseOrderAction(sendTarget.id));
          setSendTarget(null);
        }}
        onCancel={() => setSendTarget(null)}
      />

      <ConfirmDialog
        open={cancelTarget !== null}
        title={tActions('cancelTitle')}
        description={tActions('cancelBody')}
        confirmLabel={tActions('cancel')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          if (cancelTarget) run(() => cancelPurchaseOrderAction(cancelTarget.id));
          setCancelTarget(null);
        }}
        onCancel={() => setCancelTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={tActions('deleteTitle')}
        description={tActions('deleteBody')}
        confirmLabel={tActions('delete')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          if (deleteTarget) run(() => deletePurchaseOrderAction(deleteTarget.id));
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}
