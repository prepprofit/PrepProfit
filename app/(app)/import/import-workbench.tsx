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
import { formatQuantity, type MeasurementSystem } from '@/lib/units';
import { useActionError } from '@/lib/i18n/use-action-error';
import { IMPORT_ENTITIES, IMPORT_FORMATS } from '@/lib/import/types';
import type {
  ImportEntity,
  ImportFormat,
  ImportIngredientRecord,
  ImportTransactionRecord,
  ImportRecipePayload,
} from '@/lib/import/types';
import {
  previewImportAction,
  confirmImportAction,
  type ImportActionState,
} from './actions';

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
}: {
  currency: string;
  measurementSystem: MeasurementSystem;
}) {
  const t = useTranslations('import');
  const [entity, setEntity] = useState<ImportEntity>('ingredients');
  const [format, setFormat] = useState<ImportFormat>('csv');
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
                onChange={(e) => setEntity(e.target.value as ImportEntity)}
              >
                {IMPORT_ENTITIES.map((value) => (
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
                onChange={(e) => setFormat(e.target.value as ImportFormat)}
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
  onStartOver,
}: {
  entity: ImportEntity;
  format: ImportFormat;
  currency: string;
  measurementSystem: MeasurementSystem;
  onStartOver: () => void;
}) {
  const t = useTranslations('import');
  const actionError = useActionError();
  const [previewState, previewAction, previewing] = useActionState(
    previewImportAction,
    null as ImportActionState | null,
  );
  const [confirmState, confirmAction, confirming] = useActionState(
    confirmImportAction,
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
  confirmState: ImportActionState | null;
  confirmAction: (formData: FormData) => void;
  confirming: boolean;
  onStartOver: () => void;
}) {
  const t = useTranslations('import');
  const actionError = useActionError();
  const { counts, issues, sample, entity } = preview;
  const shownIssues = issues.slice(0, ISSUE_DISPLAY_LIMIT);

  // Recipe-only: the per-distinct-ingredient resolution choices. A FUZZY name
  // defaults to "create new" (never auto-linked); EXACT/NEW are server-forced and
  // not user-editable here. The chosen links travel to confirm as a JSON field.
  const recipePayload = preview.recipePayload;
  const [linkChoices, setLinkChoices] = useState<Record<string, string>>(() =>
    initFuzzyChoices(recipePayload),
  );
  const resolutionsJson = useMemo(
    () => JSON.stringify(buildResolutions(linkChoices)),
    [linkChoices],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('summary.title')}</CardTitle>
        <CardDescription>{t('summary.file', { name: preview.filename ?? '' })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* Counts. */}
        <div className="flex flex-wrap gap-2 text-sm">
          <Stat tone="good" label={t('summary.importable', { count: counts.importable })} />
          {counts.skipped > 0 && (
            <Stat tone="muted" label={t('summary.skipped', { count: counts.skipped })} />
          )}
          {counts.invalid > 0 && (
            <Stat tone="bad" label={t('summary.invalid', { count: counts.invalid })} />
          )}
          <Stat tone="muted" label={t('summary.total', { count: counts.total })} />
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

        {/* Recipe resolution panel + recipe grid. */}
        {entity === 'recipes' && recipePayload && (
          <>
            <RecipeResolutionPanel
              payload={recipePayload}
              choices={linkChoices}
              onChange={(name, value) =>
                setLinkChoices((prev) => ({ ...prev, [name]: value }))
              }
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
              <Button type="submit" disabled={confirming}>
                {confirming
                  ? t('confirming')
                  : t('confirm', { count: counts.importable })}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{t('nothingToImport')}</p>
          )}
          <Button variant="ghost" onClick={onStartOver} disabled={confirming}>
            {t('startOver')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Sentinel choice value meaning "stage a new ingredient" (vs an ingredient id). */
const CREATE_NEW = '__new__';

/** Default each FUZZY name to "create new" — fuzzy matches are never auto-linked. */
function initFuzzyChoices(
  payload: ImportRecipePayload | undefined,
): Record<string, string> {
  if (!payload) return {};
  const init: Record<string, string> = {};
  for (const [name, res] of Object.entries(payload.resolutions)) {
    if (res.kind === 'fuzzy') init[name] = CREATE_NEW;
  }
  return init;
}

/** Build the confirm `resolutions` payload from the fuzzy link choices. */
function buildResolutions(
  choices: Record<string, string>,
): { name: string; action: 'link' | 'create'; ingredientId?: string }[] {
  return Object.entries(choices).map(([name, value]) =>
    value === CREATE_NEW
      ? { name, action: 'create' }
      : { name, action: 'link', ingredientId: value },
  );
}

/**
 * Per-distinct-ingredient resolution. EXACT names show their auto-link (read-only),
 * NEW names show "will be created (needs pricing)", and FUZZY names offer a radio
 * group of the suggested matches plus "create new" (the default) — the only place a
 * suggestion can be linked, and only by explicit choice.
 */
function RecipeResolutionPanel({
  payload,
  choices,
  onChange,
}: {
  payload: ImportRecipePayload;
  choices: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  const t = useTranslations('import.recipes');
  const entries = Object.entries(payload.resolutions);
  const exactCount = entries.filter(([, r]) => r.kind === 'exact').length;
  const newCount = entries.filter(([, r]) => r.kind === 'new').length;
  const fuzzy = entries.filter(([, r]) => r.kind === 'fuzzy');

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground">{t('resolve.title')}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {exactCount > 0 && (
          <Stat tone="good" label={t('resolve.linked', { count: exactCount })} />
        )}
        {newCount > 0 && (
          <Stat tone="muted" label={t('resolve.willCreate', { count: newCount })} />
        )}
        {fuzzy.length > 0 && (
          <Stat tone="bad" label={t('resolve.review', { count: fuzzy.length })} />
        )}
      </div>

      {fuzzy.length > 0 && (
        <ul className="flex flex-col gap-3">
          {fuzzy.map(([name, res]) => {
            if (res.kind !== 'fuzzy') return null;
            const selected = choices[name] ?? CREATE_NEW;
            return (
              <li
                key={name}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2/40 p-3"
              >
                <p className="text-sm font-medium text-foreground">
                  {t('resolve.forName', { name })}
                </p>
                <div className="flex flex-col gap-1.5">
                  {res.suggestions.map((s) => (
                    <label
                      key={s.ingredientId}
                      className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                    >
                      <input
                        type="radio"
                        name={`resolve-${name}`}
                        value={s.ingredientId}
                        checked={selected === s.ingredientId}
                        onChange={() => onChange(name, s.ingredientId)}
                        className="size-4 accent-accent-600"
                      />
                      <span>{s.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('resolve.match', { percent: Math.round(s.score * 100) })}
                      </span>
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <input
                      type="radio"
                      name={`resolve-${name}`}
                      value={CREATE_NEW}
                      checked={selected === CREATE_NEW}
                      onChange={() => onChange(name, CREATE_NEW)}
                      className="size-4 accent-accent-600"
                    />
                    <span>{t('resolve.createNew')}</span>
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The staged recipes with their grouped ingredient lines (read-only preview). */
function RecipeGrid({
  payload,
  measurementSystem,
}: {
  payload: ImportRecipePayload;
  measurementSystem: MeasurementSystem;
}) {
  const t = useTranslations('import.recipes');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground">{t('grid.title')}</p>
      <div className="flex flex-col gap-3">
        {payload.recipes.map((recipe, i) => (
          <div key={i} className="rounded-lg border border-border">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border bg-surface-2/50 px-3 py-2">
              <span className="text-sm font-medium text-foreground">{recipe.name}</span>
              <span className="text-xs text-muted-foreground">
                {t('grid.yield', {
                  portions: recipe.yieldPortions,
                  percent: recipe.yieldPercentage,
                })}
              </span>
            </div>
            {recipe.lines.length > 0 ? (
              <ul className="divide-y divide-border">
                {recipe.lines.map((line, j) => (
                  <li
                    key={j}
                    className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
                  >
                    <span className="text-foreground">{line.ingredientName}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatQuantity(line.quantityCanonical, line.dimension, measurementSystem)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">{t('grid.noLines')}</p>
            )}
          </div>
        ))}
      </div>
    </div>
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
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${toneClass}`}>
      {label}
    </span>
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
