'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Check, FileText, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import { formatMoney, parseMoneyToCents } from '@/lib/format/money';
import { invoiceTotals, lineTotals } from '@/lib/calculations/invoice';
import type { InvoiceStatus } from '@/lib/db/schema';
import type { ActionResult } from '@/lib/action-result';
import {
  createCustomerAction,
  createInvoiceAction,
  deleteCustomerAction,
  deleteInvoiceAction,
  issueInvoiceAction,
  markInvoicePaidAction,
  updateCustomerAction,
  updateInvoiceAction,
  voidInvoiceAction,
} from '@/app/(app)/invoices/actions';

export type CustomerOption = {
  id: string;
  name: string;
  taxId: string | null;
  address: string | null;
  email: string | null;
};

export type InvoiceRow = {
  id: string;
  status: InvoiceStatus;
  number: string | null;
  customerName: string | null;
  totalCents: number;
  issueDate: string | null;
};

/** A draft's editable contents, so the builder can load it in place. */
export type DraftDetail = {
  id: string;
  customerId: string;
  notes: string;
  lines: LineState[];
};

type LineState = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
};

const STATUS_VARIANT: Record<InvoiceStatus, 'neutral' | 'accent' | 'positive'> = {
  draft: 'neutral',
  issued: 'accent',
  paid: 'positive',
  void: 'neutral',
};

const emptyLine = (): LineState => ({
  description: '',
  quantity: '1',
  unitPrice: '',
  taxRate: '0',
});

export function InvoicesView({
  currency,
  customers,
  invoices,
  drafts,
}: {
  currency: string;
  customers: CustomerOption[];
  invoices: InvoiceRow[];
  drafts: Record<string, DraftDetail>;
}) {
  const actionError = useActionError();
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  /** Run an action, surface its error, refresh on success. */
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

      <CustomerManager
        customers={customers}
        pending={pending}
        run={run}
        setError={setError}
      />

      <InvoiceBuilder
        currency={currency}
        customers={customers}
        drafts={drafts}
        pending={pending}
        run={run}
        setError={setError}
      />

      <InvoiceList
        currency={currency}
        invoices={invoices}
        pending={pending}
        run={run}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Customers                                                                   */
/* -------------------------------------------------------------------------- */

function CustomerManager({
  customers,
  pending,
  run,
  setError,
}: {
  customers: CustomerOption[];
  pending: boolean;
  run: (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => void;
  setError: (msg: string | null) => void;
}) {
  const t = useTranslations('invoices.customers');
  const tCommon = useTranslations('common');
  const [open, setOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [taxId, setTaxId] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<CustomerOption | null>(
    null,
  );
  const [query, setQuery] = React.useState('');
  const q = query.trim().toLowerCase();
  const visibleCustomers = q
    ? customers.filter((c) => c.name.toLowerCase().includes(q))
    : customers;

  const reset = () => {
    setEditingId(null);
    setName('');
    setTaxId('');
    setAddress('');
    setEmail('');
    setOpen(false);
  };

  const startEdit = (c: CustomerOption) => {
    setEditingId(c.id);
    setName(c.name);
    setTaxId(c.taxId ?? '');
    setAddress(c.address ?? '');
    setEmail(c.email ?? '');
    setOpen(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() === '') {
      setError(t('name'));
      return;
    }
    const payload = { name, taxId, address, email };
    run(
      () =>
        editingId
          ? updateCustomerAction(editingId, payload)
          : createCustomerAction(payload),
      reset,
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t('title')}</CardTitle>
        {!open && (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            {t('add')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {open && (
          <form
            onSubmit={submit}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-4"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cust-name">{t('name')}</Label>
                <Input
                  id="cust-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cust-tax">{t('taxId')}</Label>
                <Input
                  id="cust-tax"
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cust-email">{t('email')}</Label>
                <Input
                  id="cust-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cust-address">{t('address')}</Label>
                <Input
                  id="cust-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {editingId ? tCommon('save') : tCommon('add')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={pending}>
                {tCommon('cancel')}
              </Button>
            </div>
          </form>
        )}

        <Input
          type="search"
          aria-label={tCommon('searchPlaceholder')}
          placeholder={tCommon('searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />

        {visibleCustomers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {q ? tCommon('noMatches') : t('empty')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {visibleCustomers.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {c.name}
                  </span>
                  {(c.email || c.taxId) && (
                    <span className="truncate text-xs text-muted-foreground">
                      {[c.taxId, c.email].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('edit')}
                    disabled={pending}
                    onClick={() => startEdit(c)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('deleteTitle')}
                    disabled={pending}
                    onClick={() => setDeleteTarget(c)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('deleteTitle')}
        description={t('deleteBody')}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          if (deleteTarget) run(() => deleteCustomerAction(deleteTarget.id));
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

function InvoiceBuilder({
  currency,
  customers,
  drafts,
  pending,
  run,
  setError,
}: {
  currency: string;
  customers: CustomerOption[];
  drafts: Record<string, DraftDetail>;
  pending: boolean;
  run: (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => void;
  setError: (msg: string | null) => void;
}) {
  const t = useTranslations('invoices.builder');
  const tErr = useTranslations('invoices.errors');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [customerId, setCustomerId] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<LineState[]>([emptyLine()]);

  // Expose an editing entry-point to the list via a custom event (keeps the two
  // sibling components decoupled without a shared store).
  React.useEffect(() => {
    const onEdit = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const draft = drafts[id];
      if (!draft) return;
      setEditingId(draft.id);
      setCustomerId(draft.customerId);
      setNotes(draft.notes);
      setLines(draft.lines.length > 0 ? draft.lines : [emptyLine()]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('pp-edit-invoice', onEdit);
    return () => window.removeEventListener('pp-edit-invoice', onEdit);
  }, [drafts]);

  const reset = () => {
    setEditingId(null);
    setCustomerId('');
    setNotes('');
    setLines([emptyLine()]);
  };

  const updateLine = (index: number, patch: Partial<LineState>) => {
    setLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    );
  };

  const addLine = () => setLines((prev) => [...prev, emptyLine()]);
  const removeLine = (index: number) =>
    setLines((prev) =>
      prev.length === 1 ? prev : prev.filter((_, i) => i !== index),
    );

  // Parse the editable strings into the calc's numeric line shape.
  const parsedLines = lines.map((l) => ({
    quantity: Number(l.quantity) || 0,
    unitPriceCents: parseMoneyToCents(l.unitPrice),
    taxRate: Number(l.taxRate) || 0,
  }));
  const totals = invoiceTotals(parsedLines);

  const buildItems = () =>
    lines
      .map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity) || 0,
        unitPriceCents: parseMoneyToCents(l.unitPrice),
        taxRate: Number(l.taxRate) || 0,
      }))
      .filter((l) => l.description !== '' && l.quantity > 0);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const items = buildItems();
    if (items.length === 0) {
      setError(tErr('lineIncomplete'));
      return;
    }
    const payload = {
      customerId: customerId || null,
      notes,
      items,
    };
    run(
      () =>
        editingId
          ? updateInvoiceAction(editingId, payload)
          : createInvoiceAction(payload),
      reset,
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editingId ? t('editTitle') : t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-customer">{t('customer')}</Label>
              <Select
                id="inv-customer"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">{t('selectCustomer')}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-notes">{t('notes')}</Label>
              <Input
                id="inv-notes"
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
                const lt = lineTotals({
                  quantity: Number(line.quantity) || 0,
                  unitPriceCents: parseMoneyToCents(line.unitPrice),
                  taxRate: Number(line.taxRate) || 0,
                });
                return (
                  <div
                    key={index}
                    className="grid grid-cols-1 items-end gap-2 rounded-lg border border-border bg-surface-2 p-3 sm:grid-cols-[1fr_5rem_8rem_5rem_auto]"
                  >
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`line-desc-${index}`} className="text-xs">
                        {t('description')}
                      </Label>
                      <Input
                        id={`line-desc-${index}`}
                        value={line.description}
                        onChange={(e) =>
                          updateLine(index, { description: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`line-qty-${index}`} className="text-xs">
                        {t('quantity')}
                      </Label>
                      <Input
                        id={`line-qty-${index}`}
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(e) =>
                          updateLine(index, { quantity: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`line-price-${index}`} className="text-xs">
                        {t('unitPrice')}
                      </Label>
                      <Input
                        id={`line-price-${index}`}
                        inputMode="decimal"
                        placeholder="0.00"
                        value={line.unitPrice}
                        onChange={(e) =>
                          updateLine(index, { unitPrice: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`line-tax-${index}`} className="text-xs">
                        {t('taxRate')}
                      </Label>
                      <Input
                        id={`line-tax-${index}`}
                        inputMode="decimal"
                        value={line.taxRate}
                        onChange={(e) =>
                          updateLine(index, { taxRate: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-end">
                      <span className="text-sm font-medium text-foreground">
                        {formatMoney(lt.grossCents, currency)}
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

          {/* Live totals */}
          <div className="ml-auto flex w-full max-w-xs flex-col gap-1 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>{t('subtotal')}</span>
              <span>{formatMoney(totals.subtotalCents, currency)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>{t('tax')}</span>
              <span>{formatMoney(totals.taxCents, currency)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1 font-semibold text-foreground">
              <span>{t('grandTotal')}</span>
              <span>{formatMoney(totals.totalCents, currency)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending}>
              <FileText className="size-4" />
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

function InvoiceList({
  currency,
  invoices,
  pending,
  run,
}: {
  currency: string;
  invoices: InvoiceRow[];
  pending: boolean;
  run: (fn: () => Promise<ActionResult<unknown>>, after?: () => void) => void;
}) {
  const t = useTranslations('invoices');
  const tList = useTranslations('invoices.list');
  const tStatus = useTranslations('invoices.status');
  const tActions = useTranslations('invoices.actions');
  const tCommon = useTranslations('common');

  const [issueTarget, setIssueTarget] = React.useState<InvoiceRow | null>(null);
  const [dueDate, setDueDate] = React.useState('');
  const [voidTarget, setVoidTarget] = React.useState<InvoiceRow | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<InvoiceRow | null>(null);

  const editDraft = (id: string) => {
    window.dispatchEvent(new CustomEvent('pp-edit-invoice', { detail: id }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tList('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {invoices.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-10 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {invoices.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[inv.status]}>
                      {tStatus(inv.status)}
                    </Badge>
                    <span className="text-sm font-medium text-foreground">
                      {inv.number ?? tList('noNumber')}
                    </span>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {inv.customerName ?? tList('noCustomer')}
                    {inv.issueDate ? ` · ${inv.issueDate}` : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">
                    {formatMoney(inv.totalCents, currency)}
                  </span>
                  {inv.status !== 'draft' && (
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/invoices/${inv.id}`}>{tActions('view')}</Link>
                    </Button>
                  )}
                  {inv.status === 'draft' && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => editDraft(inv.id)}
                      >
                        <Pencil className="size-4" />
                        {tActions('edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setDueDate('');
                          setIssueTarget(inv);
                        }}
                      >
                        <Check className="size-4" />
                        {tActions('issue')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={tActions('delete')}
                        disabled={pending}
                        onClick={() => setDeleteTarget(inv)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                  {inv.status === 'issued' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(() => markInvoicePaidAction(inv.id))}
                    >
                      {tActions('markPaid')}
                    </Button>
                  )}
                  {(inv.status === 'issued' || inv.status === 'paid') && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => setVoidTarget(inv)}
                    >
                      {tActions('void')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Issue dialog (with optional due date) */}
      <ConfirmDialog
        open={issueTarget !== null}
        title={tActions('issueTitle')}
        description={tActions('issueBody')}
        confirmLabel={tActions('issue')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={() => {
          if (issueTarget) {
            run(() =>
              issueInvoiceAction(issueTarget.id, {
                dueDate: dueDate || null,
              }),
            );
          }
          setIssueTarget(null);
        }}
        onCancel={() => setIssueTarget(null)}
      >
        <div className="mt-3 flex flex-col gap-1.5">
          <Label htmlFor="issue-due">{tActions('dueDate')}</Label>
          <Input
            id="issue-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={voidTarget !== null}
        title={tActions('voidTitle')}
        description={tActions('voidBody')}
        confirmLabel={tActions('void')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          if (voidTarget) run(() => voidInvoiceAction(voidTarget.id));
          setVoidTarget(null);
        }}
        onCancel={() => setVoidTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={tActions('deleteTitle')}
        description={tActions('deleteBody')}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        destructive
        pending={pending}
        onConfirm={() => {
          if (deleteTarget) run(() => deleteInvoiceAction(deleteTarget.id));
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}
