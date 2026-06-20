'use client';

import { useMemo, useState, useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Camera, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { type MeasurementSystem } from '@/lib/units';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { ActionErrorCode } from '@/lib/action-result';
import type { PhotoExtractionPreview } from '@/lib/ai/types';
import { confirmImportAction, type ImportActionState } from '@/app/(app)/import/actions';
import {
  RecipeResolutionPanel,
  RecipeGrid,
  Stat,
  initFuzzyChoices,
  buildResolutions,
} from '@/app/(app)/import/recipe-resolution';

const ISSUE_DISPLAY_LIMIT = 50;

/**
 * AI photo extraction workbench (Sprint 4.7). The upload posts to the Route Handler
 * (`/api/recipes/import/photo`) via fetch — the only stage that touches the provider
 * — and the returned staged draft is reviewed with the SAME 4.6 resolution panel +
 * recipe grid, then confirmed through the unchanged `confirmImportAction`. Quality
 * flags from the model are surfaced as warnings; nothing is written without confirm.
 */
export function PhotoImportWorkbench({
  measurementSystem,
}: {
  measurementSystem: MeasurementSystem;
}) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <PhotoFlow
      key={resetKey}
      measurementSystem={measurementSystem}
      onStartOver={() => setResetKey((k) => k + 1)}
    />
  );
}

function PhotoFlow({
  measurementSystem,
  onStartOver,
}: {
  measurementSystem: MeasurementSystem;
  onStartOver: () => void;
}) {
  const t = useTranslations('recipes.importPhoto');
  const actionError = useActionError();

  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<ActionErrorCode | null>(null);
  const [preview, setPreview] = useState<PhotoExtractionPreview | null>(null);
  const [linkChoices, setLinkChoices] = useState<Record<string, string>>({});

  const [confirmState, confirmAction, confirming] = useActionState(
    confirmImportAction,
    null as ImportActionState | null,
  );
  const committed =
    confirmState?.ok && confirmState.phase === 'committed' ? confirmState : null;

  async function onExtract(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const image = data.get('image');
    if (!(image instanceof File) || image.size === 0) {
      setError('INVALID_INPUT');
      return;
    }
    setError(null);
    setExtracting(true);
    try {
      const res = await fetch('/api/recipes/import/photo', { method: 'POST', body: data });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: ActionErrorCode };
        setError(body.code ?? 'UNEXPECTED');
        return;
      }
      const result = (await res.json()) as PhotoExtractionPreview;
      setPreview(result);
      setLinkChoices(initFuzzyChoices(result.recipePayload));
    } catch {
      setError('UNEXPECTED');
    } finally {
      setExtracting(false);
    }
  }

  // Success screen.
  if (committed) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-6">
          <p className="inline-flex items-center gap-2 text-sm font-medium text-emerald-600">
            <CheckCircle2 className="size-5" />
            {committed.alreadyCommitted
              ? t('committed.already')
              : t('committed.created', { count: committed.created })}
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
      <Card>
        <CardHeader>
          <CardTitle>{t('upload.title')}</CardTitle>
          <CardDescription>{t('upload.help')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onExtract} className="flex flex-col gap-4">
            <input
              type="file"
              name="image"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              required
              className="block w-full cursor-pointer rounded-lg border border-border bg-surface text-sm text-foreground transition-colors file:mr-4 file:cursor-pointer file:border-0 file:bg-surface-2 file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-foreground hover:bg-surface-2/50"
            />
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {actionError(error)}
              </p>
            )}
            <div>
              <Button type="submit" disabled={extracting}>
                {extracting ? (
                  <>
                    <Sparkles className="size-4 animate-pulse" />
                    {t('upload.extracting')}
                  </>
                ) : (
                  <>
                    <Camera className="size-4" />
                    {t('upload.cta')}
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {preview && (
        <PhotoPreview
          preview={preview}
          measurementSystem={measurementSystem}
          choices={linkChoices}
          onChoiceChange={(name, value) =>
            setLinkChoices((prev) => ({ ...prev, [name]: value }))
          }
          confirmState={confirmState}
          confirmAction={confirmAction}
          confirming={confirming}
          onStartOver={onStartOver}
        />
      )}
    </div>
  );
}

function PhotoPreview({
  preview,
  measurementSystem,
  choices,
  onChoiceChange,
  confirmState,
  confirmAction,
  confirming,
  onStartOver,
}: {
  preview: PhotoExtractionPreview;
  measurementSystem: MeasurementSystem;
  choices: Record<string, string>;
  onChoiceChange: (name: string, value: string) => void;
  confirmState: ImportActionState | null;
  confirmAction: (formData: FormData) => void;
  confirming: boolean;
  onStartOver: () => void;
}) {
  const t = useTranslations('recipes.importPhoto');
  const tImport = useTranslations('import');
  const actionError = useActionError();
  const { counts, issues, recipePayload, qualityFlags } = preview;
  const shownIssues = issues.slice(0, ISSUE_DISPLAY_LIMIT);
  const resolutionsJson = useMemo(
    () => JSON.stringify(buildResolutions(choices)),
    [choices],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('preview.title')}</CardTitle>
        <CardDescription>{t('preview.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* Model quality warnings — low-confidence/ambiguous values are flagged, never
            silently trusted. */}
        {qualityFlags.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle className="size-4" />
              {t('preview.qualityTitle')}
            </p>
            <ul className="flex flex-col gap-1 text-sm text-amber-700 dark:text-amber-200">
              {qualityFlags.map((flag) => (
                <li key={flag}>{t(`flags.${flag}`)}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Counts. */}
        <div className="flex flex-wrap gap-2 text-sm">
          <Stat tone="good" label={t('preview.importable', { count: counts.importable })} />
          {counts.skipped > 0 && (
            <Stat tone="muted" label={t('preview.skipped', { count: counts.skipped })} />
          )}
        </div>

        {/* Issues (reuse the deterministic-import issue copy). */}
        {issues.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
              <AlertTriangle className="size-4 text-amber-500" />
              {tImport('issues.title')}
            </p>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {shownIssues.map((issue, i) => (
                <li key={`${issue.line}-${issue.column}-${i}`}>
                  <span className="font-medium text-foreground">
                    {tImport('issues.line', { line: issue.line })}
                  </span>
                  {issue.column && <span> · {issue.column}</span>}
                  <span> — {tImport(`issues.codes.${issue.code}`)}</span>
                </li>
              ))}
            </ul>
            {issues.length > shownIssues.length && (
              <p className="text-xs text-muted-foreground">
                {tImport('issues.more', { count: issues.length - shownIssues.length })}
              </p>
            )}
          </div>
        )}

        {/* Reused 4.6 resolution panel + recipe grid. */}
        <RecipeResolutionPanel payload={recipePayload} choices={choices} onChange={onChoiceChange} />
        <RecipeGrid payload={recipePayload} measurementSystem={measurementSystem} />

        {confirmState && !confirmState.ok && (
          <p className="text-sm text-destructive" role="alert">
            {actionError(confirmState.code)}
          </p>
        )}

        {/* Mandatory confirm — nothing is created until the user reviews and confirms. */}
        <div className="flex flex-wrap items-center gap-3">
          {counts.importable > 0 ? (
            <form action={confirmAction}>
              <input type="hidden" name="jobId" value={preview.jobId} />
              <input type="hidden" name="resolutions" value={resolutionsJson} />
              <Button type="submit" disabled={confirming}>
                {confirming
                  ? t('preview.confirming')
                  : t('preview.confirm', { count: counts.importable })}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{t('preview.nothingToImport')}</p>
          )}
          <Button variant="ghost" onClick={onStartOver} disabled={confirming}>
            {t('startOver')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
