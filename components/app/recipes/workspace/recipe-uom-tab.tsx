'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useActionError } from '@/lib/i18n/use-action-error';
import {
  createPrepActionAction,
  deleteEquivalencyAction,
  deletePrepActionAction,
  updatePrepActionAction,
  upsertEquivalencyAction,
} from '@/app/(app)/ingredients/uom-actions';
import { hasUsableAnchorPair, type UomAnchors } from '@/lib/calculations/uom';
import type { Dimension } from '@/lib/units';

/**
 * UoM Equivalency tab (Recipes 2.0 Fase 4, plan §6.6): per-ingredient anchors
 * (weight/volume/each describing the SAME amount) + prep actions with usable
 * yield. OPERATIONAL — both roles see and edit it; nothing here is money.
 * Missing equivalencies are called out with the exact missing anchor so a
 * volume/count line is never silently unconvertible (§7.2).
 */

export type UomPrepActionView = {
  id: string;
  name: string;
  yieldBps: number;
  weightGrams: number | null;
  volumeMl: number | null;
  eachCount: number | null;
  sortOrder: number;
};

export type UomTabItem = {
  ingredientId: string;
  name: string;
  dimension: Dimension;
  equivalency: (UomAnchors & { source: 'manual' | 'standard' }) | null;
  prepActions: UomPrepActionView[];
  /**
   * Dimensions this recipe's lines for the ingredient still cannot convert
   * to weight (set server-side from entered units; empty = fine).
   */
  missingAnchorDimensions: Dimension[];
};

const parseAnchor = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed.replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
};

const anchorText = (value: number | null): string => (value === null ? '' : String(value));

export function RecipeUomTab({ items }: { items: UomTabItem[] }) {
  const t = useTranslations('recipes.workspace.uom');

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <UomIngredientRow key={item.ingredientId} item={item} />
      ))}
    </ul>
  );
}

function UomIngredientRow({ item }: { item: UomTabItem }) {
  const t = useTranslations('recipes.workspace.uom');
  const router = useRouter();
  const actionError = useActionError();
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [weight, setWeight] = React.useState(anchorText(item.equivalency?.weightGrams ?? null));
  const [volume, setVolume] = React.useState(anchorText(item.equivalency?.volumeMl ?? null));
  const [each, setEach] = React.useState(anchorText(item.equivalency?.eachCount ?? null));

  const draftAnchors: UomAnchors = {
    weightGrams: parseAnchor(weight),
    volumeMl: parseAnchor(volume),
    eachCount: parseAnchor(each),
  };

  const run = async (fn: () => Promise<{ ok: boolean; code?: string }>) => {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.ok && result.code) {
      setError(actionError(result.code as Parameters<typeof actionError>[0]));
      return false;
    }
    router.refresh();
    return true;
  };

  const saveEquivalency = () =>
    run(() =>
      upsertEquivalencyAction({
        ingredientId: item.ingredientId,
        ...draftAnchors,
        source: 'manual',
      }),
    ).then((ok) => ok && setEditing(false));

  const removeEquivalency = () =>
    run(() => deleteEquivalencyAction({ ingredientId: item.ingredientId })).then(
      (ok) => ok && setEditing(false),
    );

  const summary = item.equivalency
    ? [
        item.equivalency.weightGrams !== null ? `${item.equivalency.weightGrams} g` : null,
        item.equivalency.volumeMl !== null ? `${item.equivalency.volumeMl} ml` : null,
        item.equivalency.eachCount !== null
          ? t('eachSummary', { count: item.equivalency.eachCount })
          : null,
      ]
        .filter((part) => part !== null)
        .join(' = ')
    : null;

  return (
    <li className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.name}</p>
          {summary ? (
            <p className="text-xs text-muted-foreground tabular-nums">{summary}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{t('noEquivalency')}</p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setEditing((v) => !v)}
          aria-label={t('editEquivalency', { name: item.name })}
        >
          <Pencil /> {t('edit')}
        </Button>
      </div>

      {item.missingAnchorDimensions.length > 0 ? (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {t('missingAnchors', {
            anchors: item.missingAnchorDimensions
              .map((d) => t(`anchorName.${d}`))
              .join(', '),
          })}
        </p>
      ) : null}

      {editing ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">{t('anchorsHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <AnchorInput
              label={t('anchorName.weight')}
              unit="g"
              value={weight}
              onChange={setWeight}
            />
            <AnchorInput
              label={t('anchorName.volume')}
              unit="ml"
              value={volume}
              onChange={setVolume}
            />
            <AnchorInput
              label={t('anchorName.count')}
              unit={t('eachUnit')}
              value={each}
              onChange={setEach}
            />
          </div>
          {error ? (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={saveEquivalency}
              disabled={busy || !hasUsableAnchorPair(draftAnchors)}
            >
              {t('save')}
            </Button>
            {item.equivalency ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={removeEquivalency}
                disabled={busy}
              >
                <Trash2 /> {t('remove')}
              </Button>
            ) : null}
          </div>
          {!hasUsableAnchorPair(draftAnchors) ? (
            <p className="text-xs text-muted-foreground">{t('needTwoAnchors')}</p>
          ) : null}
        </div>
      ) : null}

      <PrepActionList item={item} run={run} busy={busy} />
    </li>
  );
}

function AnchorInput({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="h-8 w-24 text-right tabular-nums"
        aria-label={label}
      />
      {unit}
    </label>
  );
}

function PrepActionList({
  item,
  run,
  busy,
}: {
  item: UomTabItem;
  run: (fn: () => Promise<{ ok: boolean; code?: string }>) => Promise<boolean>;
  busy: boolean;
}) {
  const t = useTranslations('recipes.workspace.uom');
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState('');
  const [yieldPct, setYieldPct] = React.useState('100');

  const yieldBpsFromPct = (raw: string): number | null => {
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
    return Math.round(value * 100);
  };

  const addPrep = async () => {
    const yieldBps = yieldBpsFromPct(yieldPct);
    if (!yieldBps || name.trim() === '') return;
    const ok = await run(() =>
      createPrepActionAction({
        ingredientId: item.ingredientId,
        name: name.trim(),
        yieldBps,
        weightGrams: null,
        volumeMl: null,
        eachCount: null,
        sortOrder: item.prepActions.length,
      }),
    );
    if (ok) {
      setAdding(false);
      setName('');
      setYieldPct('100');
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('prepActions')}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setAdding((v) => !v)}
          aria-label={t('addPrepAction', { name: item.name })}
        >
          <Plus /> {t('add')}
        </Button>
      </div>

      {item.prepActions.length === 0 && !adding ? (
        <p className="text-xs text-muted-foreground">{t('noPrepActions')}</p>
      ) : null}

      <ul className="mt-1 flex flex-col gap-1">
        {item.prepActions.map((prep) => (
          <PrepActionRow key={prep.id} prep={prep} run={run} busy={busy} />
        ))}
      </ul>

      {adding ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('prepNamePlaceholder')}
            className="h-8 w-40"
            aria-label={t('prepNamePlaceholder')}
          />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            {t('yield')}
            <Input
              value={yieldPct}
              onChange={(e) => setYieldPct(e.target.value)}
              inputMode="decimal"
              className="h-8 w-20 text-right tabular-nums"
              aria-label={t('yield')}
            />
            %
          </label>
          <Button
            type="button"
            size="sm"
            onClick={addPrep}
            disabled={busy || name.trim() === '' || yieldBpsFromPct(yieldPct) === null}
          >
            {t('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PrepActionRow({
  prep,
  run,
  busy,
}: {
  prep: UomPrepActionView;
  run: (fn: () => Promise<{ ok: boolean; code?: string }>) => Promise<boolean>;
  busy: boolean;
}) {
  const t = useTranslations('recipes.workspace.uom');
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(prep.name);
  const [yieldPct, setYieldPct] = React.useState(String(prep.yieldBps / 100));

  const yieldBps = (() => {
    const value = Number(yieldPct.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
    return Math.round(value * 100);
  })();

  const save = async () => {
    if (!yieldBps || name.trim() === '') return;
    const ok = await run(() =>
      updatePrepActionAction({
        prepActionId: prep.id,
        name: name.trim(),
        yieldBps,
        weightGrams: prep.weightGrams,
        volumeMl: prep.volumeMl,
        eachCount: prep.eachCount,
        sortOrder: prep.sortOrder,
      }),
    );
    if (ok) setEditing(false);
  };

  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      {editing ? (
        <>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 w-40"
            aria-label={t('prepNamePlaceholder')}
          />
          <Input
            value={yieldPct}
            onChange={(e) => setYieldPct(e.target.value)}
            inputMode="decimal"
            className="h-8 w-20 text-right tabular-nums"
            aria-label={t('yield')}
          />
          <span className="text-xs text-muted-foreground">%</span>
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={busy || !yieldBps || name.trim() === ''}
          >
            {t('save')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t('cancel')}
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 truncate">{prep.name}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('yieldSummary', { pct: prep.yieldBps / 100 })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            aria-label={t('editPrepAction', { name: prep.name })}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => run(() => deletePrepActionAction({ prepActionId: prep.id }))}
            disabled={busy}
            aria-label={t('removePrepAction', { name: prep.name })}
          >
            <Trash2 />
          </Button>
        </>
      )}
    </li>
  );
}
