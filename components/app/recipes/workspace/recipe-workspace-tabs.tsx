'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/format/money';
import { scaleMoneyCents } from '@/lib/calculations/recipeScale';
import type { RecipeCost } from '@/lib/calculations/recipeCost';

export type WorkspaceTab = 'method' | 'cost' | 'nutrition' | 'uom';

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
 * carries none, and the tab shows a managers-only note. Nutrition and UoM are
 * placeholders until Fases 4/6.
 */
export function RecipeWorkspaceTabs({
  tab,
  onTabChange,
  methodSections,
  methodEditor,
  legacyNotes,
  cost,
  factor,
  currency,
}: {
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  methodSections: MethodSectionView[];
  /** Edit-mode replacement for the read-only method panel (Fase 3). */
  methodEditor?: React.ReactNode;
  legacyNotes: string | null;
  /** null = kitchen (never shipped); `incomplete` = tree unresolvable. */
  cost: { complete: true; cost: RecipeCost } | { complete: false } | null;
  factor: number;
  currency: string;
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
          <CostPanel cost={cost} factor={factor} currency={currency} />
        ) : null}
        {tab === 'nutrition' || tab === 'uom' ? (
          <p className="text-sm text-muted-foreground">{t('comingSoon')}</p>
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
}: {
  cost: { complete: true; cost: RecipeCost } | { complete: false } | null;
  factor: number;
  currency: string;
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

  return (
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
  );
}
