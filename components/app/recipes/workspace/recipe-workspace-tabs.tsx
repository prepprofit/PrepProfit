'use client';

import { useTranslations } from 'next-intl';
import type { UomAnchors } from '@/lib/calculations/uom';
import type { Dimension } from '@/lib/units';

/**
 * Shared view types for the recipe page + the read-only preparation method.
 *
 * Costs are MANAGER-ONLY: the kitchen payload ships `cost: null` and none of these
 * keys exist in it. Only what matters is carried — a cost beside each ingredient
 * line, cost per batch and cost per kg — plus any labour/energy left over from the
 * retired editor so it stays visible for review.
 */

export type WorkspaceCostView =
  | {
      complete: true;
      /** Cost of one batch as saved (ingredients + remaining hidden costs), cents. */
      batchCostCents: number;
      /** Batch cost ÷ finished weight; null when no finished weight is known. */
      costPerKgCents: number | null;
      /** Line key → line cost in cents (null = no price yet). */
      lineCosts: Record<string, number | null>;
      legacy: { labourCents: number; energyCents: number };
    }
  | {
      complete: false;
      lineCosts: Record<string, number | null>;
      /** Ingredient lines still missing a price. */
      unpricedLineKeys: string[];
      legacy: { labourCents: number; energyCents: number };
    }
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

/** Unit-conversion context per ingredient — used by the line editor, not rendered. */
export type UomTabItem = {
  ingredientId: string;
  name: string;
  dimension: Dimension;
  equivalency: (UomAnchors & { source: 'manual' | 'standard' }) | null;
  prepActions: {
    id: string;
    name: string;
    yieldBps: number;
    weightGrams: number | null;
    volumeMl: number | null;
    eachCount: number | null;
    sortOrder: number;
  }[];
  missingAnchorDimensions: Dimension[];
};

export function MethodPanel({
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
