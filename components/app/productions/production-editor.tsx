'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import type { ProductionRecipeOption } from '@/lib/data/productions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  createProductionAction,
  deleteProductionAction,
  planProductionAction,
  updateProductionAction,
} from '@/app/(app)/productions/actions';
import { useActionError } from '@/lib/i18n/use-action-error';

/** A line as the editor holds it (money-free — recipe identity + planned portions). */
export type EditorProductionLine = {
  recipeId: string;
  recipeName: string;
  plannedQty: number;
  available: boolean;
};

export type ProductionEditorInitial = {
  reference: string | null;
  notes: string | null;
  plannedFor: string | null;
  lines: EditorProductionLine[];
};

/**
 * Draft production editor (Sprint 11a), shared by both roles. Manages the recipe
 * lines + reference/date/notes, and (in edit mode) the Plan / Reopen-adjacent state
 * transitions. It is MONEY-FREE: it receives no cost and never renders any — the
 * manager cost card is a separate server-rendered card. Every state/edit mutation
 * carries `expectedUpdatedAt` for optimistic concurrency; after each success the page
 * refreshes so the next mutation uses the fresh version.
 */
export function ProductionEditor({
  mode,
  productionId,
  initial,
  expectedUpdatedAt,
  recipeOptions,
  canSeeCost,
}: {
  mode: 'create' | 'edit';
  productionId?: string;
  initial: ProductionEditorInitial;
  /** Required in edit mode — the optimistic-concurrency token. */
  expectedUpdatedAt?: string;
  recipeOptions: ProductionRecipeOption[];
  canSeeCost: boolean;
}) {
  const t = useTranslations('productions');
  const tCommon = useTranslations('common');
  const actionError = useActionError();
  const router = useRouter();

  const [reference, setReference] = React.useState(initial.reference ?? '');
  const [plannedFor, setPlannedFor] = React.useState(initial.plannedFor ?? '');
  const [notes, setNotes] = React.useState(initial.notes ?? '');
  const [lines, setLines] = React.useState<EditorProductionLine[]>(initial.lines);
  const [newRecipeId, setNewRecipeId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const availableOptions = recipeOptions.filter(
    (o) => !lines.some((l) => l.recipeId === o.id),
  );
  const allAvailable = lines.every((l) => l.available);
  const canPlan =
    mode === 'edit' &&
    lines.length > 0 &&
    allAvailable &&
    plannedFor.trim() !== '';

  const dirty = (): void => setSaved(false);

  const addLine = () => {
    const opt = recipeOptions.find((o) => o.id === newRecipeId);
    if (!opt) return;
    setLines((prev) => [
      ...prev,
      { recipeId: opt.id, recipeName: opt.name, plannedQty: 1, available: true },
    ]);
    setNewRecipeId('');
    dirty();
  };

  const setLineQty = (recipeId: string, value: string) => {
    const n = Math.round(Number(value) || 0);
    setLines((prev) =>
      prev.map((l) =>
        l.recipeId === recipeId
          ? { ...l, plannedQty: Math.min(100000, Math.max(1, n || 1)) }
          : l,
      ),
    );
    dirty();
  };

  const removeLine = (recipeId: string) => {
    setLines((prev) => prev.filter((l) => l.recipeId !== recipeId));
    dirty();
  };

  const buildPayload = () => ({
    reference: reference.trim() === '' ? null : reference.trim(),
    notes: notes.trim() === '' ? null : notes.trim(),
    plannedFor: plannedFor.trim() === '' ? null : plannedFor.trim(),
    items: lines.map((l) => ({ recipeId: l.recipeId, plannedQty: l.plannedQty })),
  });

  const onSave = () => {
    if (lines.length === 0) {
      setError(t('errors.noItems'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result =
        mode === 'create'
          ? await createProductionAction(buildPayload())
          : await updateProductionAction(productionId as string, {
              expectedUpdatedAt: expectedUpdatedAt as string,
              ...buildPayload(),
            });
      if (result.ok) {
        if (mode === 'create') {
          router.push(`/productions/${result.data.id}`);
        } else {
          setSaved(true);
          router.refresh();
        }
      } else {
        setError(actionError(result.code));
      }
    });
  };

  const onPlan = () => {
    setError(null);
    startTransition(async () => {
      const result = await planProductionAction(productionId as string, {
        expectedUpdatedAt: expectedUpdatedAt as string,
      });
      if (result.ok) router.refresh();
      else setError(actionError(result.code));
    });
  };

  const confirmDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteProductionAction(productionId as string, {
        expectedUpdatedAt: expectedUpdatedAt as string,
      });
      if (result.ok) router.push('/productions');
      else {
        setError(actionError(result.code));
        setConfirmOpen(false);
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/productions"
          className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          aria-label={t('actions.back')}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <Input
          aria-label={t('fields.reference')}
          placeholder={t('fields.referencePlaceholder')}
          className="h-11 max-w-md flex-1 text-lg font-medium"
          value={reference}
          disabled={pending}
          onChange={(e) => {
            setReference(e.target.value);
            dirty();
          }}
        />
        <div className="ml-auto flex items-center gap-2">
          {saved && (
            <span className="inline-flex items-center gap-1 text-sm text-brand-700 dark:text-brand-300">
              <CheckCircle2 className="size-4" />
              {t('saved')}
            </span>
          )}
          <Button type="button" onClick={onSave} disabled={pending}>
            {mode === 'create' ? t('actions.create') : t('actions.save')}
          </Button>
          {mode === 'edit' && (
            <>
              <Button type="button" onClick={onPlan} disabled={pending || !canPlan}>
                {t('actions.plan')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmOpen(true)}
                disabled={pending}
                aria-label={t('actions.delete')}
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {!allAvailable && lines.length > 0 && (
        <p
          role="status"
          className="inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
        >
          <AlertTriangle className="size-4 shrink-0" />
          {canSeeCost ? t('incomplete.managerBody') : t('incomplete.kitchenBody')}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Recipes */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('composition.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2">{t('composition.recipe')}</th>
                    <th className="pb-2">{t('composition.quantity')}</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        {t('composition.empty')}
                      </td>
                    </tr>
                  )}
                  {lines.map((line) => (
                    <tr
                      key={line.recipeId}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-2 pr-2">
                        <span className="font-medium text-foreground">
                          {line.recipeName}
                        </span>
                        {!line.available && (
                          <Badge variant="warning" className="ml-2">
                            {t('unavailableLine')}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        <Input
                          aria-label={t('composition.quantity')}
                          type="number"
                          min={1}
                          max={100000}
                          inputMode="numeric"
                          className="w-24"
                          value={String(line.plannedQty)}
                          disabled={pending}
                          onChange={(e) => setLineQty(line.recipeId, e.target.value)}
                        />
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t('composition.remove')}
                          disabled={pending}
                          onClick={() => removeLine(line.recipeId)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add line */}
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <Select
                aria-label={t('composition.add')}
                value={newRecipeId}
                disabled={pending || availableOptions.length === 0}
                onChange={(e) => setNewRecipeId(e.target.value)}
              >
                <option value="">
                  {availableOptions.length === 0
                    ? t('composition.allAdded')
                    : t('composition.select')}
                </option>
                {availableOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                onClick={addLine}
                disabled={pending || newRecipeId === ''}
              >
                <Plus className="size-4" />
                {t('composition.add')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Plan details */}
        <Card>
          <CardHeader>
            <CardTitle>{t('fields.plannedFor')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                {t('fields.plannedFor')}
              </span>
              <Input
                type="date"
                value={plannedFor}
                disabled={pending}
                onChange={(e) => {
                  setPlannedFor(e.target.value);
                  dirty();
                }}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                {t('fields.notes')}
              </span>
              <Textarea
                value={notes}
                disabled={pending}
                placeholder={t('placeholders.notes')}
                onChange={(e) => {
                  setNotes(e.target.value);
                  dirty();
                }}
              />
            </label>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', {
          name: initial.reference ?? t('fallbackLabel'),
        })}
        confirmLabel={tCommon('moveToTrash')}
        cancelLabel={tCommon('cancel')}
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
