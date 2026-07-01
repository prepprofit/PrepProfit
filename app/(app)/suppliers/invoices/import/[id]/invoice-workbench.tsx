'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Pencil,
  Search,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { normalizeIngredientName } from '@/lib/import/resolveIngredient';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { ActionErrorCode } from '@/lib/action-result';
import type { IngredientOption } from '@/lib/data/ingredients';
import type {
  SupplierInvoiceImportStatus,
  SupplierInvoiceLineStatus,
  SupplierInvoiceLineIssueCode,
} from '@/lib/ai/operation-types';
import {
  updateInvoiceLineAction,
  applyInvoiceImportAction,
  voidInvoiceImportAction,
} from '@/app/(app)/suppliers/invoices/actions';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-accent-500';

const PACK_UNITS = ['g', 'kg', 'ml', 'l', 'oz', 'lb', 'floz', 'cup', 'tsp', 'tbsp', 'count'];

type HeaderView = {
  supplierNameRaw: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currencyCode: string | null;
  status: SupplierInvoiceImportStatus;
};

type LineView = {
  id: string;
  rawText: string | null;
  itemNameRaw: string;
  matchedIngredientId: string | null;
  quantityValue: string | null;
  quantityUnit: string | null;
  packSizeValue: string | null;
  packSizeUnit: string | null;
  unitPriceCents: number | null;
  status: SupplierInvoiceLineStatus;
  issues: SupplierInvoiceLineIssueCode[];
};

/** Cents → a plain major-unit string for the editable price field (blank when null). */
function centsToInput(cents: number | null): string {
  return cents == null ? '' : (cents / 100).toFixed(2);
}

/** A major-unit price string → integer cents, or null when blank/invalid. */
function inputToCents(value: string): number | null {
  const v = value.trim();
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function numInput(value: string): number | null {
  const v = value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Supplier invoice review workbench (Sprint 2). Each line is editable + matchable; a
 * line is `ready` only once matched + complete. Applying records PENDING price
 * observations only — it never changes an approved cost. Terminal (applied/void)
 * imports are read-only.
 */
export function InvoiceReviewWorkbench({
  importId,
  header,
  lines,
  ingredientOptions,
}: {
  importId: string;
  header: HeaderView;
  lines: LineView[];
  ingredientOptions: IngredientOption[];
}) {
  const t = useTranslations('suppliers.invoices.review');
  const actionError = useActionError();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionErrorCode | null>(null);
  const [summary, setSummary] = useState<{ applied: number; skipped: number } | null>(null);

  const optionsById = useMemo(
    () => new Map(ingredientOptions.map((o) => [o.id, o])),
    [ingredientOptions],
  );

  const readyCount = lines.filter((l) => l.status === 'ready').length;
  const needsReviewCount = lines.filter((l) => l.status === 'needs_review').length;
  const editable = header.status === 'draft';

  function apply() {
    setError(null);
    startTransition(async () => {
      const res = await applyInvoiceImportAction(importId);
      if (res.ok) {
        setSummary(res.data);
        router.refresh();
      } else {
        setError(res.code);
      }
    });
  }

  function voidImport() {
    setError(null);
    startTransition(async () => {
      const res = await voidInvoiceImportAction(importId);
      if (!res.ok) setError(res.code);
      else router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/suppliers/invoices/import"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        ← {t('back')}
      </Link>

      {/* Header */}
      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Field label={t('supplier')} value={header.supplierNameRaw ?? t('unknownSupplier')} />
          <Field label={t('number')} value={header.invoiceNumber ?? '—'} />
          <Field label={t('date')} value={header.invoiceDate ?? '—'} />
          <Field label={t('currency')} value={header.currencyCode ?? '—'} />
        </div>
      </div>

      {summary && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-400/60 bg-emerald-50/50 p-3 dark:bg-emerald-500/5">
          <span className="inline-flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <Check className="size-4" />
            {t('applied', { applied: summary.applied, skipped: summary.skipped })}
          </span>
          <Button asChild variant="outline" size="sm">
            <Link href="/ingredients">
              {t('viewIngredients')}
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      )}

      {header.status === 'void' && (
        <p className="rounded-lg border border-border bg-surface-2/50 p-3 text-sm text-muted-foreground">
          {t('voided')}
        </p>
      )}

      {/* Line count summary */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Stat tone={readyCount > 0 ? 'good' : 'muted'} label={t('ready', { count: readyCount })} />
        {needsReviewCount > 0 && (
          <Stat tone="bad" label={t('needsReview', { count: needsReviewCount })} />
        )}
      </div>

      {/* Lines */}
      <ul className="flex flex-col gap-2">
        {lines.map((line) => (
          <LineRow
            key={line.id}
            importId={importId}
            line={line}
            editable={editable}
            currency={header.currencyCode ?? ''}
            ingredientOptions={ingredientOptions}
            matchedName={line.matchedIngredientId ? optionsById.get(line.matchedIngredientId)?.name : undefined}
            onSaved={() => router.refresh()}
          />
        ))}
      </ul>

      {error && (
        <p className="text-sm font-medium text-red-600 dark:text-red-400">{actionError(error)}</p>
      )}

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={apply} disabled={pending || readyCount === 0}>
            {t('apply', { count: readyCount })}
          </Button>
          <Button variant="outline" onClick={voidImport} disabled={pending}>
            {t('void')}
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

function LineRow({
  importId,
  line,
  editable,
  currency,
  ingredientOptions,
  matchedName,
  onSaved,
}: {
  importId: string;
  line: LineView;
  editable: boolean;
  currency: string;
  ingredientOptions: IngredientOption[];
  matchedName: string | undefined;
  onSaved: () => void;
}) {
  const t = useTranslations('suppliers.invoices.review');
  const tIssues = useTranslations('suppliers.invoices.review.lineIssues');
  const actionError = useActionError();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionErrorCode | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [matchId, setMatchId] = useState<string | null>(line.matchedIngredientId);
  const [qty, setQty] = useState(line.quantityValue ?? '');
  const [packSize, setPackSize] = useState(line.packSizeValue ?? '');
  const [packUnit, setPackUnit] = useState(line.packSizeUnit ?? '');
  const [price, setPrice] = useState(centsToInput(line.unitPriceCents));

  const applied = line.status === 'applied';
  const ignored = line.status === 'ignored';

  function persist(patch: Record<string, unknown>) {
    setError(null);
    startTransition(async () => {
      const res = await updateInvoiceLineAction(importId, line.id, patch);
      if (res.ok) onSaved();
      else setError(res.code);
    });
  }

  function save() {
    persist({
      matchedIngredientId: matchId,
      quantityValue: numInput(qty),
      packSizeValue: numInput(packSize),
      packSizeUnit: packUnit.trim() === '' ? null : packUnit,
      unitPriceCents: inputToCents(price),
    });
  }

  const tone =
    line.status === 'ready'
      ? 'good'
      : line.status === 'applied'
        ? 'muted'
        : line.status === 'ignored'
          ? 'muted'
          : 'bad';
  const statusLabel =
    line.status === 'ready'
      ? t('statusReady')
      : line.status === 'applied'
        ? t('statusApplied')
        : line.status === 'ignored'
          ? t('statusIgnored')
          : t('statusNeedsReview');

  return (
    <li
      className={`flex flex-col gap-3 rounded-lg border p-3 ${
        line.status === 'needs_review'
          ? 'border-amber-400/60 bg-amber-50/30 dark:bg-amber-500/5'
          : 'border-border bg-surface-2/30'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {line.itemNameRaw}
        </span>
        <Stat tone={tone} label={statusLabel} />
      </div>

      {line.issues.length > 0 && !applied && !ignored && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-amber-700 dark:text-amber-300">
          {line.issues.map((code) => (
            <span key={code} className="inline-flex items-center gap-1">
              <AlertTriangle className="size-3" />
              {tIssues(code)}
            </span>
          ))}
        </div>
      )}

      {editable && !ignored && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('quantity')}
              <input
                className={inputClass}
                value={qty}
                inputMode="decimal"
                onChange={(e) => setQty(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('packSize')}
              <input
                className={inputClass}
                value={packSize}
                inputMode="decimal"
                onChange={(e) => setPackSize(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('packUnit')}
              <select
                className={inputClass}
                value={packUnit}
                onChange={(e) => setPackUnit(e.target.value)}
              >
                <option value="">—</option>
                {PACK_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {`${t('unitPrice')}${currency ? ` (${currency})` : ''}`}
              <input
                className={inputClass}
                value={price}
                inputMode="decimal"
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('columns.ingredient')}
              <Button
                variant={matchId ? 'outline' : 'default'}
                size="sm"
                className="justify-start"
                onClick={() => setPickerOpen(true)}
              >
                {matchId ? (
                  <>
                    <Pencil className="size-3.5" />
                    <span className="truncate">{matchedName ?? t('changeMatch')}</span>
                  </>
                ) : (
                  <>
                    <Search className="size-3.5" />
                    {t('match')}
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={save} disabled={pending}>
              <Check className="size-3.5" />
              {t('save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => persist({ ignored: true })}
              disabled={pending}
            >
              <Trash2 className="size-3.5" />
              {t('ignore')}
            </Button>
          </div>
        </>
      )}

      {editable && ignored && (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => persist({ ignored: false })}
            disabled={pending}
          >
            <RotateCcw className="size-3.5" />
            {t('restore')}
          </Button>
        </div>
      )}

      {error && (
        <p className="text-xs font-medium text-red-600 dark:text-red-400">{actionError(error)}</p>
      )}

      <IngredientPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        displayName={line.itemNameRaw}
        options={ingredientOptions}
        onSelect={(id) => {
          setMatchId(id);
          setPickerOpen(false);
        }}
      />
    </li>
  );
}

const SEARCH_LIMIT = 60;

function IngredientPicker({
  open,
  onOpenChange,
  displayName,
  options,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  options: IngredientOption[];
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('suppliers.invoices.review');
  const [query, setQuery] = useState('');

  const indexed = useMemo(
    () => options.map((o) => ({ o, norm: normalizeIngredientName(o.name) })),
    [options],
  );
  const results = useMemo(() => {
    const q = normalizeIngredientName(query);
    const list = q === '' ? indexed : indexed.filter((i) => i.norm.includes(q));
    return list.slice(0, SEARCH_LIMIT).map((i) => i.o);
  }, [indexed, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
          <DialogTitle className="border-b border-border px-4 pt-3 text-sm font-medium text-foreground">
            {t('searchTitle', { name: displayName })}
          </DialogTitle>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Command shouldFilter={false} className="gap-0">
              <CommandInput
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={t('searchPlaceholder')}
              />
              <CommandList>
                {results.length > 0 ? (
                  <CommandGroup>
                    {results.map((o) => (
                      <CommandItem key={o.id} value={o.id} onSelect={() => onSelect(o.id)}>
                        {o.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : (
                  <p className="px-3 py-3 text-sm text-muted-foreground">{t('noResults')}</p>
                )}
              </CommandList>
            </Command>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ tone, label }: { tone: 'good' | 'bad' | 'muted'; label: string }) {
  const toneClass =
    tone === 'good'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
      : tone === 'bad'
        ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
        : 'bg-surface-2 text-muted-foreground';
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${toneClass}`}>{label}</span>
  );
}
