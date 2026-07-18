'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/format/money';
import { scaleMoneyCents } from '@/lib/calculations/recipeScale';
import type { RecipeCost } from '@/lib/calculations/recipeCost';
import {
  PortionOptionsSection,
  type PortionYieldContext,
} from './recipe-portion-options';

export type WorkspaceTab = 'method' | 'cost' | 'nutrition' | 'uom';

/**
 * One expandable row of the cost panel (Fase 5, §7.3) — MANAGER-ONLY data
 * assembled server-side; the kitchen payload ships `cost: null` and none of
 * these keys ever exist in it.
 */
export type CostLineDetailView = {
  key: string;
  kind: 'ingredient' | 'component';
  name: string;
  prepName: string | null;
  /** Pre-formatted canonical amount, e.g. "500 g" (server formats). */
  quantityLabel: string;
  needsPricing: boolean;
  /** Line cost at 1x batch (client scales by factor); null = unpriced. */
  lineCostCents: number | null;
  /** Approved price per purchase unit (ingredient lines only). */
  priceCents: number | null;
  /** Purchase-unit label for the price, e.g. "kg" / "l" / "pc". */
  unitLabel: string | null;
  supplierName: string | null;
  packSize: number | null;
  packUnit: string | null;
  packPriceCents: number | null;
  priceSource: 'manual' | 'order' | 'quote' | 'import' | null;
  /** ISO date of the accepted price observation. */
  priceSourceDate: string | null;
};

/**
 * Cost of one portion option as its fraction of the batch (Fase 5, §6.8),
 * extended in Fase 5b with the editable fields the manager CRUD form needs.
 * Lives INSIDE `cost`, so it is manager-only by construction — the kitchen
 * payload ships `cost: null` and none of these keys ever exist in it.
 */
export type PortionCostView = {
  key: string;
  name: string;
  quantityLabel: string;
  /** Raw quantity/unit the edit form starts from. */
  quantity: number;
  unit: string;
  isDefault: boolean;
  isNutritionServing: boolean;
  sellingPriceCents: number | null;
  targetFoodCostBps: number | null;
  /** null = incomputable (unit mismatch / missing yield) — renders "—". */
  costCents: number | null;
};

export type WorkspaceCostView =
  | {
      complete: true;
      cost: RecipeCost;
      details: CostLineDetailView[];
      /** Cost per kg of finished batch (scale-invariant); null when no weight. */
      costPerKgCents: number | null;
      /** Cost per chef-facing yield unit, e.g. per "qt" (scale-invariant). */
      perYieldUnit: { unit: string; cents: number } | null;
      portionCosts: PortionCostView[];
    }
  | { complete: false }
  | null;

export type MethodSectionView = {
  id: string;
  title: string;
  steps: {
    id: string;
    instruction: string;
    /** Signed short-lived URLs of READY media (empty when signing unavailable). */
    media: { mediaId: string; url: string | null; kind: 'image' | 'video' }[];
  }[];
};

/**
 * Right-panel tab shell (plan §5/§9.2): the active tab is URL state managed by
 * the parent; switching tabs never unmounts the workspace. Cost is rendered
 * ONLY when the server shipped cost data (manager) — the kitchen payload
 * carries none, and the tab shows a managers-only note. Nutrition (Fase 6) and
 * UoM (Fase 4) render the panels the parent injects.
 */
export function RecipeWorkspaceTabs({
  tab,
  onTabChange,
  methodSections,
  methodEditor,
  uomPanel,
  nutritionPanel,
  legacyNotes,
  cost,
  factor,
  currency,
  recipeId,
  recipeYield,
}: {
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  methodSections: MethodSectionView[];
  /** Edit-mode replacement for the read-only method panel (Fase 3). */
  methodEditor?: React.ReactNode;
  /** UoM Equivalency panel (Fase 4) — rendered when the tab is active. */
  uomPanel?: React.ReactNode;
  /** Nutrition panel (Fase 6) — rendered when the tab is active. */
  nutritionPanel?: React.ReactNode;
  legacyNotes: string | null;
  /** null = kitchen (never shipped); `incomplete` = tree unresolvable. */
  cost: WorkspaceCostView;
  factor: number;
  currency: string;
  recipeId: string;
  /** Yield context for the portion calculator (operational, non-financial). */
  recipeYield: Omit<PortionYieldContext, 'totalCostCents'>;
}) {
  const t = useTranslations('recipes.workspace');
  const tabs: WorkspaceTab[] = ['method', 'cost', 'nutrition', 'uom'];

  return (
    <div>
      <div
        role="tablist"
        aria-label={t('tabs.method')}
        className="sticky top-0 z-10 flex gap-1 border-b border-border bg-background pb-px"
      >
        {tabs.map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => onTabChange(key)}
            className={
              tab === key
                ? 'rounded-t-lg border-b-2 border-accent-700 px-3 py-2 text-sm font-medium text-foreground'
                : 'rounded-t-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
            }
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>

      <div className="pt-4">
        {tab === 'method' ? (
          (methodEditor ?? (
            <MethodPanel sections={methodSections} legacyNotes={legacyNotes} />
          ))
        ) : null}
        {tab === 'cost' ? (
          <CostPanel
            cost={cost}
            factor={factor}
            currency={currency}
            recipeId={recipeId}
            recipeYield={recipeYield}
          />
        ) : null}
        {tab === 'uom' ? (
          (uomPanel ?? (
            <p className="text-sm text-muted-foreground">{t('comingSoon')}</p>
          ))
        ) : null}
        {tab === 'nutrition' ? (
          (nutritionPanel ?? (
            <p className="text-sm text-muted-foreground">{t('comingSoon')}</p>
          ))
        ) : null}
      </div>
    </div>
  );
}

function MethodPanel({
  sections,
  legacyNotes,
}: {
  sections: MethodSectionView[];
  legacyNotes: string | null;
}) {
  const t = useTranslations('recipes.workspace.method');
  const hasSteps = sections.some((s) => s.steps.length > 0);

  return (
    <div className="flex flex-col gap-5">
      {!hasSteps && !legacyNotes ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : null}
      {sections.map((section) => (
        <section key={section.id}>
          {section.title ? (
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {section.title}
            </h3>
          ) : null}
          <ol className="flex flex-col gap-3">
            {section.steps.map((step, index) => (
              <li key={step.id} className="flex gap-3">
                <span className="mt-0.5 size-6 shrink-0 rounded-full bg-surface-2 text-center text-xs font-medium leading-6">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  {/* Step text renders as TEXT — never HTML (plan §12). */}
                  <p className="whitespace-pre-wrap text-sm">
                    {step.instruction}
                  </p>
                  {step.media.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {step.media.map((m) =>
                        m.url === null ? null : m.kind === 'video' ? (
                          <video
                            key={m.mediaId}
                            src={m.url}
                            controls
                            preload="metadata"
                            className="max-h-48 rounded-lg border border-border"
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                          <img
                            key={m.mediaId}
                            src={m.url}
                            alt=""
                            loading="lazy"
                            className="max-h-48 rounded-lg border border-border object-cover"
                          />
                        ),
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {legacyNotes ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('legacyNotes')}
          </h3>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {legacyNotes}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function CostPanel({
  cost,
  factor,
  currency,
  recipeId,
  recipeYield,
}: {
  cost: WorkspaceCostView;
  factor: number;
  currency: string;
  recipeId: string;
  recipeYield: Omit<PortionYieldContext, 'totalCostCents'>;
}) {
  const t = useTranslations('recipes.workspace.cost');

  if (cost === null) {
    return <p className="text-sm text-muted-foreground">{t('managersOnly')}</p>;
  }
  if (!cost.complete) {
    return <p className="text-sm text-muted-foreground">{t('incomplete')}</p>;
  }

  const rows: { label: string; cents: number }[] = [
    {
      label: t('ingredientCost'),
      cents: scaleMoneyCents(cost.cost.ingredientCostCents, factor),
    },
    {
      label: t('hiddenCost'),
      cents: scaleMoneyCents(cost.cost.hiddenCostCents, factor),
    },
    {
      label: t('totalCost'),
      cents: scaleMoneyCents(cost.cost.totalCostCents, factor),
    },
    { label: t('costPerPortion'), cents: cost.cost.costPerPortionCents },
  ];
  // Scale-invariant per-unit metrics (§16 Fase 5 slice 5): cost/kg and cost
  // per chef-facing yield unit are the same at any batch factor.
  if (cost.costPerKgCents !== null) {
    rows.push({ label: t('costPerKg'), cents: cost.costPerKgCents });
  }
  if (cost.perYieldUnit !== null) {
    rows.push({
      label: t('costPerYieldUnit', { unit: cost.perYieldUnit.unit }),
      cents: cost.perYieldUnit.cents,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className="rounded-lg border border-border bg-surface px-4 py-3"
          >
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {formatMoney(row.cents, currency)}
            </dd>
          </div>
        ))}
      </dl>

      {/* Fase 5b: manager CRUD + bidirectional calculator. Safe here — this
          branch only renders when the server shipped cost data (manager). */}
      <PortionOptionsSection
        recipeId={recipeId}
        portions={cost.portionCosts}
        yieldContext={{
          totalCostCents: cost.cost.totalCostCents,
          ...recipeYield,
        }}
        currency={currency}
      />

      {cost.details.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('lines')}
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {cost.details.map((line) => (
              <li key={line.key}>
                <details className="group">
                  <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 truncate">
                      {line.name}
                      {line.prepName ? (
                        <span className="text-muted-foreground">
                          {' '}
                          · {line.prepName}
                        </span>
                      ) : null}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {line.quantityLabel}
                      </span>
                    </span>
                    {line.needsPricing || line.lineCostCents === null ? (
                      <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('needsPricing')}
                      </span>
                    ) : (
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatMoney(
                          scaleMoneyCents(line.lineCostCents, factor),
                          currency,
                        )}
                      </span>
                    )}
                  </summary>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border bg-surface-2/50 px-4 py-3 text-xs">
                    {line.priceCents !== null && line.unitLabel ? (
                      <>
                        <dt className="text-muted-foreground">
                          {t('approvedPrice')}
                        </dt>
                        <dd className="text-right tabular-nums">
                          {formatMoney(line.priceCents, currency)} / {line.unitLabel}
                        </dd>
                      </>
                    ) : null}
                    <dt className="text-muted-foreground">{t('supplier')}</dt>
                    <dd className="truncate text-right">
                      {line.supplierName ?? '—'}
                    </dd>
                    {line.packSize !== null && line.packUnit ? (
                      <>
                        <dt className="text-muted-foreground">
                          {t('purchaseItem')}
                        </dt>
                        <dd className="text-right tabular-nums">
                          {line.packSize} {line.packUnit}
                          {line.packPriceCents !== null
                            ? ` — ${formatMoney(line.packPriceCents, currency)}`
                            : ''}
                        </dd>
                      </>
                    ) : null}
                    <dt className="text-muted-foreground">{t('priceOrigin')}</dt>
                    <dd className="text-right">
                      {line.priceSource
                        ? t(`priceSources.${line.priceSource}`)
                        : '—'}
                      {line.priceSourceDate
                        ? ` · ${new Date(line.priceSourceDate).toLocaleDateString()}`
                        : ''}
                    </dd>
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
