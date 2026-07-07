'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Plus, Pencil, Archive, ArchiveRestore, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useActionError } from '@/lib/i18n/use-action-error';
import { useRowHighlight } from '@/lib/hooks/use-row-highlight';
import { cn } from '@/lib/utils';
import {
  archiveSupplierAction,
  createSupplierAction,
  reactivateSupplierAction,
  updateSupplierAction,
} from '@/app/(app)/suppliers/actions';

export type SupplierRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxId: string | null;
  notes: string | null;
  active: boolean;
  ingredientCount: number;
};

type FormState = {
  name: string;
  email: string;
  phone: string;
  address: string;
  taxId: string;
  notes: string;
};

function emptyForm(): FormState {
  return { name: '', email: '', phone: '', address: '', taxId: '', notes: '' };
}

function formFromRow(row: SupplierRow): FormState {
  return {
    name: row.name,
    email: row.email ?? '',
    phone: row.phone ?? '',
    address: row.address ?? '',
    taxId: row.taxId ?? '',
    notes: row.notes ?? '',
  };
}

/**
 * Suppliers list + editor (Sprint 7), MANAGER-ONLY (the page gates the route; every
 * action re-checks on the server). Create / edit happen in a shared dialog; archive
 * is a confirm (blocked server-side while the supplier is an ingredient default);
 * reactivate flips it back. Archived rows are hidden until the toggle is on.
 */
export function SuppliersView({
  suppliers,
  highlightId,
}: {
  suppliers: SupplierRow[];
  highlightId?: string;
}) {
  const t = useTranslations('suppliers');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const flashId = useRowHighlight(highlightId, 'supplier-row-');

  const [rows, setRows] = React.useState<SupplierRow[]>(suppliers);
  const [showArchived, setShowArchived] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Shared create/edit dialog.
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<FormState>(emptyForm);

  const [confirmArchiveId, setConfirmArchiveId] = React.useState<string | null>(null);

  const visible = showArchived ? rows : rows.filter((r) => r.active);
  const archiveTarget = rows.find((r) => r.id === confirmArchiveId) ?? null;
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (formOpen && !el.open) el.showModal();
    else if (!formOpen && el.open) el.close();
  }, [formOpen]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
    setFormOpen(true);
  };

  const openEdit = (row: SupplierRow) => {
    setEditingId(row.id);
    setForm(formFromRow(row));
    setError(null);
    setFormOpen(true);
  };

  const onSubmit = () => {
    const input = {
      name: form.name.trim(),
      email: form.email,
      phone: form.phone,
      address: form.address,
      taxId: form.taxId,
      notes: form.notes,
    };
    if (input.name === '') {
      setError(actionError('INVALID_INPUT'));
      return;
    }
    setError(null);
    startTransition(async () => {
      if (editingId) {
        const result = await updateSupplierAction(editingId, input);
        if (result.ok) {
          setRows((prev) =>
            prev.map((r) =>
              r.id === editingId ? { ...r, ...result.data } : r,
            ),
          );
          setFormOpen(false);
        } else {
          setError(actionError(result.code));
        }
      } else {
        const result = await createSupplierAction(input);
        if (result.ok) {
          setRows((prev) => [
            ...prev,
            { ...result.data, ingredientCount: 0 },
          ]);
          setFormOpen(false);
        } else {
          setError(actionError(result.code));
        }
      }
    });
  };

  const onArchive = () => {
    const id = confirmArchiveId;
    if (!id) return;
    setError(null);
    startTransition(async () => {
      const result = await archiveSupplierAction(id);
      if (result.ok) {
        setRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, active: false } : r)),
        );
      } else {
        setError(actionError(result.code));
      }
      setConfirmArchiveId(null);
    });
  };

  const onReactivate = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await reactivateSupplierAction(id);
      if (result.ok) {
        setRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, active: true } : r)),
        );
      } else {
        setError(actionError(result.code));
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 rounded border-border"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {t('showArchived')}
        </label>
        <Button type="button" onClick={openCreate} disabled={pending}>
          <Plus className="size-4" />
          {t('actions.new')}
        </Button>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('columns.name')}
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('columns.contact')}
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('columns.ingredients')}
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  {t('empty')}
                </td>
              </tr>
            )}
            {visible.map((row) => (
              <tr
                key={row.id}
                id={`supplier-row-${row.id}`}
                className={cn(
                  'border-b border-border align-middle transition-colors duration-700 last:border-0',
                  flashId === row.id && 'bg-accent-500/10',
                )}
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/suppliers/${row.id}`}
                      className="font-medium text-foreground hover:text-accent-700 hover:underline dark:hover:text-accent-300"
                    >
                      {row.name}
                    </Link>
                    {!row.active && (
                      <Badge variant="neutral">{t('archivedBadge')}</Badge>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {row.email ?? row.phone ?? '—'}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {t('ingredientCount', { count: row.ingredientCount })}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      asChild
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('actions.view')}
                    >
                      <Link href={`/suppliers/${row.id}`}>
                        <ExternalLink className="size-4" />
                      </Link>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('actions.edit')}
                      disabled={pending}
                      onClick={() => openEdit(row)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    {row.active ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.archive')}
                        disabled={pending}
                        onClick={() => setConfirmArchiveId(row.id)}
                      >
                        <Archive className="size-4" />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.reactivate')}
                        disabled={pending}
                        onClick={() => onReactivate(row.id)}
                      >
                        <ArchiveRestore className="size-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          if (!pending) setFormOpen(false);
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current && !pending) setFormOpen(false);
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-surface p-0 text-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      >
        <div className="flex flex-col gap-4 p-5">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            {editingId ? t('form.editTitle') : t('form.newTitle')}
          </h2>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${titleId}-name`}>{t('form.name')}</Label>
            <Input
              id={`${titleId}-name`}
              placeholder={t('form.namePlaceholder')}
              value={form.name}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${titleId}-email`}>{t('form.email')}</Label>
              <Input
                id={`${titleId}-email`}
                type="email"
                value={form.email}
                disabled={pending}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${titleId}-phone`}>{t('form.phone')}</Label>
              <Input
                id={`${titleId}-phone`}
                value={form.phone}
                disabled={pending}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${titleId}-address`}>{t('form.address')}</Label>
            <Input
              id={`${titleId}-address`}
              value={form.address}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${titleId}-taxId`}>{t('form.taxId')}</Label>
            <Input
              id={`${titleId}-taxId`}
              value={form.taxId}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, taxId: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${titleId}-notes`}>{t('form.notes')}</Label>
            <Textarea
              id={`${titleId}-notes`}
              value={form.notes}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>

          <div className="mt-1 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setFormOpen(false)}
              disabled={pending}
            >
              {t('form.cancel')}
            </Button>
            <Button type="button" onClick={onSubmit} disabled={pending}>
              {editingId ? t('form.save') : t('form.create')}
            </Button>
          </div>
        </div>
      </dialog>

      <ConfirmDialog
        open={confirmArchiveId !== null}
        title={t('archiveConfirm.title')}
        description={t('archiveConfirm.body')}
        confirmLabel={t('archiveConfirm.confirm')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={onArchive}
        onCancel={() => setConfirmArchiveId(null)}
      >
        <p className="text-sm font-medium text-foreground">
          {archiveTarget?.name}
        </p>
      </ConfirmDialog>
    </div>
  );
}
