'use client';

import { useMemo, useState } from 'react';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Upload, FileDown, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatMoney } from '@/lib/format/money';
import { type MeasurementSystem } from '@/lib/units';
import { useActionError } from '@/lib/i18n/use-action-error';
import { FILE_IMPORT_ENTITIES, IMPORT_FORMATS } from '@/lib/import/types';
import type {
  FileImportEntity,
  FileImportFormat,
  ImportIngredientRecord,
  ImportTransactionRecord,
  ImportSaleClose,
} from '@/lib/import/types';
import {
  previewImportAction,
  confirmImportAction,
  type ImportActionState,
} from './actions';
import {
  previewSalesImportAction,
  confirmSalesImportAction,
} from './sales-actions';
import {
  RecipeResolutionPanel,
  RecipeGrid,
  Stat,
  initResolutionChoices,
  buildResolutions,
  countUnresolved,
  countDimensionMismatches,
} from './recipe-resolution';
import type { IngredientOption } from '@/lib/data/ingredients';

const ISSUE_DISPLAY_LIMIT = 50;

/**
 * Manager-only import UI (Sprint 4.5). Two stages backed by Server Actions:
 * preview (upload → staged job) and confirm (job id → applied). The selection +
 * template download live in the outer shell; the per-attempt action state lives
 * in `<ImportFlow>`, remounted via `key` on "start over" so the form resets.
 */
export function ImportWorkbench({
  currency,
  measurementSystem,
  ingredientOptions,
}: {
  currency: string;
  measurementSystem: MeasurementSystem;
  ingredientOptions: IngredientOption[];
}) {
  const t = useTranslations('import');
  const [entity, setEntity] = useState<FileImportEntity>('ingredients');
  const [format, setFormat] = useState<FileImportFormat>('csv');
  const [resetKey, setResetKey] = useState(0);

  const templateHref = `/api/import/template?entity=${entity}&format=${format}`;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="entity">{t('entity.label')}</Label>
              <Select
                id="entity"
                value={entity}
                onChange={(e) => setEntity(e.target.value as FileImportEntity)}
              >
                {FILE_IMPORT_ENTITIES.map((value) => (
                  <option key={value} value={value}>
                    {t(`entity.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="format">{t('format.label')}</Label>
              <Select
                id="format"
                value={format}
                onChange={(e) => setFormat(e.target.value as FileImportFormat)}
              >
                {IMPORT_FORMATS.map((value) => (
                  <option key={value} value={value}>
                    {t(`format.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2/50 p-4">
            <p className="text-sm font-medium text-foreground">{t('template.title')}</p>
            <p className="text-xs text-muted-foreground">{t('template.help')}</p>
            <a
              href={templateHref}
              className="mt-1 inline-flex w-fit items-center gap-2 text-sm font-medium text-accent-700 hover:text-accent-800 dark:text-accent-300"
            >
              <FileDown className="size-4" />
              {t('template.download', { format: t(`format.${format}`) })}
            </a>
          </div>
        </CardContent>
      </Card>

      <ImportFlow
        key={resetKey}
        entity={entity}
        format={format}
        currency={currency}
        measurementSystem={measurementSystem}
        ingredientOptions={ingredientOptions}
        onStartOver={() => setResetKey((k) => k + 1)}
      />
    </div>
  );
}

function ImportFlow({
  entity,
  format,
  currency,
  measurementSystem,
  ingredientOptions,
  onStartOver,
}: {
  entity: FileImportEntity;
  format: FileImportFormat;
  currency: string;
  measurementSystem: MeasurementSystem;
  ingredientOptions: IngredientOption[];
  onStartOver: () => void;
}) {
  const t = useTranslations('import');
  const actionError = useActionError();
  // Sales is the only plan-gated file entity, with dedicated close-oriented actions.
  const isSales = entity === 'sales';
  const [previewState, previewAction, previewing] = useActionState(
    isSales ? previewSalesImportAction : previewImportAction,
    null as ImportActionState | null,
  );
  const [confirmState, confirmAction, confirming] = useActionState(
    isSales ? confirmSalesImportAction : confirmImportAction,
    null as ImportActionState | null,
  );

  const preview =
    previewState?.ok && previewState.phase === 'preview' ? previewState.preview : null;
  const committed =
    confirmState?.ok && confirmState.phase === 'committed' ? confirmState : null;

  // Success screen.
  if (committed) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-6">
          <p className="inline-flex items-center gap-2 text-sm font-medium text-emerald-600">
            <CheckCircle2 className="size-5" />
            {committed.alreadyCommitted
              ? t('alreadyCommitted')
              : entity === 'sales'
                ? t('sales.committed', { count: committed.created })
                : t('committed', { count: committed.created })}
          </p>
          <Button variant="outline" onClick={onStartOver}>
            {t('startOver')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Upload + preview. */}
      <Card>
        <CardHeader>
          <CardTitle>{t('file.label')}</CardTitle>
          <CardDescription>{t('file.help')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={previewAction} className="flex flex-col gap-4">
            <input type="hidden" name="entity" value={entity} />
            <input type="hidden" name="format" value={format} />
            <input
              type="file"
              name="file"
              accept={format === 'csv' ? '.csv,text/csv' : '.xlsx'}
              required
              className="block w-full cursor-pointer rounded-lg border border-border bg-surface text-sm text-foreground transition-colors file:mr-4 file:cursor-pointer file:border-0 file:bg-surface-2 file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-foreground hover:bg-surface-2/50"
            />
            {previewState && !previewState.ok && (
              <p className="text-sm text-destructive" role="alert">
                {actionError(previewState.code)}
              </p>
            )}
            <div>
              <Button type="submit" disabled={previewing}>
                <Upload className="size-4" />
                {previewing ? t('previewing') : t('preview')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {preview && (
        <PreviewResult
          preview={preview}
          currency={currency}
          measurementSystem={measurementSystem}
          ingredientOptions={ingredientOptions}
          confirmState={confirmState}
          confirmAction={confirmAction}
          confirming={confirming}
          onStartOver={onStartOver}
        />
      )}
    </div>
  );
}

function PreviewResult({
  preview,
  currency,
  measurementSystem,
  ingredientOptions,
  confirmState,
  confirmAction,
  confirming,
  onStartOver,
}: {
  preview: NonNullable<
    Extract<ImportActionState, { phase: 'preview' }>['preview']
  >;
  currency: string;
  measurementSystem: MeasurementSystem;
  ingredientOptions: IngredientOption[];
  confirmState: ImportActionState | null;
  confirmAction: (formData: FormData) => void;
  confirming: boolean;
  onStartOver: () => void;
}) {
  const t = useTranslations('import');
  const tResolve = useTranslations('import.recipes.resolve');
  const actionError = useActionError();
  const { counts, issues, sample, entity } = preview;
  const shownIssues = issues.slice(0, ISSUE_DISPLAY_LIMIT);

  // Recipe-only: the per-distinct-ingredient resolution choices. Every NON-exact
  // name starts UNRESOLVED and must be linked (to any active ingredient) or created
  // explicitly; EXACT is server-forced. The chosen links travel to confirm as a JSON
  // field, and Confirm is blocked while any name is unresolved or dimension-mismatched.
  const recipePayload = preview.recipePayload;
  const [linkChoices, setLinkChoices] = useState<Record<string, string>>(() =>
    initResolutionChoices(recipePayload),
  );
  const resolutionsJson = useMemo(
    () => JSON.stringify(buildResolutions(linkChoices)),
    [linkChoices],
  );
  const unresolved = countUnresolved(recipePayload, linkChoices);
  const mismatches = countDimensionMismatches(recipePayload, linkChoices, ingredientOptions);
  const recipeBlocked = entity === 'recipes' && (unresolved > 0 || mismatches > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('summary.title')}</CardTitle>
        <CardDescription>{t('summary.file', { name: preview.filename ?? '' })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* Counts. Sales counts are BY CLOSE (a grouped daily close), not by row. */}
        <div className="flex flex-wrap gap-2 text-sm">
          <Stat
            tone="good"
            label={
              entity === 'sales'
                ? t('sales.summary.importable', { count: counts.importable })
                : t('summary.importable', { count: counts.importable })
            }
          />
          {entity === 'sales' && preview.salesPreview && preview.salesPreview.financialOnly > 0 && (
            <Stat
              tone="muted"
              label={t('sales.summary.financialOnly', {
                count: preview.salesPreview.financialOnly,
              })}
            />
          )}
          {counts.skipped > 0 && (
            <Stat
              tone="muted"
              label={
                entity === 'sales'
                  ? t('sales.summary.skipped', { count: counts.skipped })
                  : t('summary.skipped', { count: counts.skipped })
              }
            />
          )}
          {counts.invalid > 0 && (
            <Stat
              tone="bad"
              label={
                entity === 'sales'
                  ? t('sales.summary.invalid', { count: counts.invalid })
                  : t('summary.invalid', { count: counts.invalid })
              }
            />
          )}
          <Stat
            tone="muted"
            label={
              entity === 'sales'
                ? t('sales.summary.total', { count: counts.total })
                : t('summary.total', { count: counts.total })
            }
          />
        </div>

        {/* Issues. */}
        {issues.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
              <AlertTriangle className="size-4 text-amber-500" />
              {t('issues.title')}
            </p>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {shownIssues.map((issue, i) => (
                <li key={`${issue.line}-${issue.column}-${i}`}>
                  <span className="font-medium text-foreground">
                    {t('issues.line', { line: issue.line })}
                  </span>
                  {issue.column && <span> · {issue.column}</span>}
                  <span> — {t(`issues.codes.${issue.code}`)}</span>
                </li>
              ))}
            </ul>
            {issues.length > shownIssues.length && (
              <p className="text-xs text-muted-foreground">
                {t('issues.more', { count: issues.length - shownIssues.length })}
              </p>
            )}
          </div>
        )}

        {/* Sales: close-oriented preview grouped by date. */}
        {entity === 'sales' && preview.salesPreview && (
          <SalesPreviewPanel closes={preview.salesPreview.closes} currency={currency} />
        )}

        {/* Recipe resolution panel + recipe grid. */}
        {entity === 'recipes' && recipePayload && (
          <>
            <RecipeResolutionPanel
              payload={recipePayload}
              choices={linkChoices}
              onChange={(name, value) =>
                setLinkChoices((prev) => ({ ...prev, [name]: value }))
              }
              ingredientOptions={ingredientOptions}
            />
            <RecipeGrid payload={recipePayload} measurementSystem={measurementSystem} />
          </>
        )}

        {/* Ready-to-import grid (ingredients / transactions). */}
        {sample.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">{t('grid.title')}</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              {entity === 'ingredients' ? (
                <IngredientGrid
                  rows={sample as ImportIngredientRecord[]}
                  currency={currency}
                />
              ) : (
                <TransactionGrid
                  rows={sample as ImportTransactionRecord[]}
                  currency={currency}
                />
              )}
            </div>
            {counts.importable > sample.length && (
              <p className="text-xs text-muted-foreground">
                {t('grid.more', { count: counts.importable - sample.length })}
              </p>
            )}
          </div>
        )}

        {confirmState && !confirmState.ok && (
          <p className="text-sm text-destructive" role="alert">
            {actionError(confirmState.code)}
          </p>
        )}

        {/* Confirm. */}
        <div className="flex flex-wrap items-center gap-3">
          {counts.importable > 0 ? (
            <form action={confirmAction}>
              <input type="hidden" name="jobId" value={preview.jobId} />
              {entity === 'recipes' && (
                <input type="hidden" name="resolutions" value={resolutionsJson} />
              )}
              <Button type="submit" disabled={confirming || recipeBlocked}>
                {confirming
                  ? t('confirming')
                  : entity === 'sales'
                    ? t('sales.confirm', { count: counts.importable })
                    : t('confirm', { count: counts.importable })}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              {entity === 'sales' ? t('sales.nothingToImport') : t('nothingToImport')}
            </p>
          )}
          {recipeBlocked && (
            <p className="text-sm text-muted-foreground">
              {unresolved > 0
                ? tResolve('resolveMissingHint', { count: unresolved })
                : tResolve('fixDimensionHint', { count: mismatches })}
            </p>
          )}
          <Button variant="ghost" onClick={onStartOver} disabled={confirming}>
            {t('startOver')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Sales preview (Sprint 12b): the import grouped into daily closes, not a flat row
 * grid. Each close shows its date, line count, gross, stock mode and disposition.
 * A double-count caution mirrors the v1 limitation (sales revenue imported here is
 * NOT reconciled against any bank/transaction import).
 */
function SalesPreviewPanel({
  closes,
  currency,
}: {
  closes: ImportSaleClose[];
  currency: string;
}) {
  const t = useTranslations('import.sales');
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-foreground">{t('closes.title')}</p>
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span>{t('doubleCountWarning')}</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface-2/50">
            <tr>
              <HeadCell>{t('closes.date')}</HeadCell>
              <HeadCell>{t('closes.lines')}</HeadCell>
              <HeadCell>{t('closes.gross')}</HeadCell>
              <HeadCell>{t('closes.stockMode')}</HeadCell>
              <HeadCell>{t('closes.status')}</HeadCell>
            </tr>
          </thead>
          <tbody>
            {closes.map((close, i) => (
              <tr key={`${close.saleDate}-${i}`} className="border-b border-border last:border-0">
                <td className="px-3 py-2 tabular-nums text-foreground">
                  {close.saleDate || '—'}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">
                  {close.lines.length}
                </td>
                <td className="px-3 py-2 tabular-nums text-foreground">
                  {formatMoney(close.grossCents, currency)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {t(`stockMode.${close.stockMode}`)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      close.status === 'importable'
                        ? 'text-emerald-600'
                        : close.status === 'invalid'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                    }
                  >
                    {t(`status.${close.status}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HeadCell({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </th>
  );
}

function IngredientGrid({
  rows,
  currency,
}: {
  rows: ImportIngredientRecord[];
  currency: string;
}) {
  const t = useTranslations('import.grid');
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-border bg-surface-2/50">
        <tr>
          <HeadCell>{t('name')}</HeadCell>
          <HeadCell>{t('dimension')}</HeadCell>
          <HeadCell>{t('price')}</HeadCell>
          <HeadCell>{t('supplier')}</HeadCell>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border last:border-0">
            <td className="px-3 py-2 text-foreground">{r.name}</td>
            <td className="px-3 py-2 text-muted-foreground">{r.dimension}</td>
            <td className="px-3 py-2 tabular-nums text-foreground">
              {formatMoney(r.priceCents, currency)}
            </td>
            <td className="px-3 py-2 text-muted-foreground">{r.supplier ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TransactionGrid({
  rows,
  currency,
}: {
  rows: ImportTransactionRecord[];
  currency: string;
}) {
  const t = useTranslations('import.grid');
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-border bg-surface-2/50">
        <tr>
          <HeadCell>{t('date')}</HeadCell>
          <HeadCell>{t('type')}</HeadCell>
          <HeadCell>{t('category')}</HeadCell>
          <HeadCell>{t('amount')}</HeadCell>
          <HeadCell>{t('note')}</HeadCell>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border last:border-0">
            <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.occurredOn}</td>
            <td className="px-3 py-2 text-muted-foreground">{r.type}</td>
            <td className="px-3 py-2 text-foreground">{r.categoryName}</td>
            <td className="px-3 py-2 tabular-nums text-foreground">
              {formatMoney(r.amountCents, currency)}
            </td>
            <td className="px-3 py-2 text-muted-foreground">{r.note ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
