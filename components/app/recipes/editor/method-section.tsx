'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { InfoPopover } from '@/components/app/recipes/workspace/info-popover';
import { RECIPE_METHOD_MAX_LENGTH } from '@/lib/validation/recipe-editor';
import type { DraftMethodSection, DraftStep } from '@/lib/recipes/editor-model';

/**
 * "Preparation method / notes": one generous text area — type or paste the whole
 * method, no numbered fields required. A recipe that already has numbered steps
 * (saved separately by an earlier editor) keeps them: they are listed under the
 * text, still editable, in their own order and sections — never merged into the
 * text or dropped behind the chef's back.
 */
export function MethodSection({
  notes,
  onNotesChange,
  sections,
  steps,
  onStepsChange,
}: {
  notes: string;
  onNotesChange: (notes: string) => void;
  sections: DraftMethodSection[];
  steps: DraftStep[];
  onStepsChange: (steps: DraftStep[]) => void;
}) {
  const t = useTranslations('recipes.editor.method');
  const id = React.useId();
  const remaining = RECIPE_METHOD_MAX_LENGTH - notes.length;
  const titleByRef = new Map(sections.map((s) => [s.ref, s.title]));

  // Number steps within their section, in saved order (like the recipe page).
  const numbered: { step: DraftStep; number: number; heading: string | null }[] = [];
  const countBySection = new Map<string | null, number>();
  let lastSection: string | null | undefined;
  for (const step of steps) {
    const n = (countBySection.get(step.sectionRef) ?? 0) + 1;
    countBySection.set(step.sectionRef, n);
    const heading = step.sectionRef !== lastSection && step.sectionRef ? (titleByRef.get(step.sectionRef) ?? null) : null;
    lastSection = step.sectionRef;
    numbered.push({ step, number: n, heading });
  }

  return (
    <section aria-labelledby={`${id}-label`} className="flex flex-col gap-3">
      <label id={`${id}-label`} htmlFor={`${id}-notes`} className="text-lg font-semibold text-foreground">
        {t('label')}
      </label>
      <Textarea
        id={`${id}-notes`}
        value={notes}
        maxLength={RECIPE_METHOD_MAX_LENGTH}
        rows={9}
        placeholder={t('placeholder')}
        onChange={(e) => onNotesChange(e.target.value)}
        className="min-h-56 resize-y px-4 py-3 text-base leading-relaxed"
      />
      {remaining < 500 ? (
        <p className="text-right text-xs text-muted-foreground" aria-live="polite">
          {t('remaining', { count: remaining })}
        </p>
      ) : null}

      {steps.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-foreground">{t('stepsTitle')}</h3>
            <InfoPopover label={t('stepsInfoLabel')}>{t('stepsInfo')}</InfoPopover>
          </div>
          <ol className="flex flex-col gap-2">
            {numbered.map(({ step, number, heading }) => (
              <li key={step.key} className="flex flex-col gap-1.5">
                {heading ? (
                  <span className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</span>
                ) : null}
                <div className="flex items-start gap-2">
                  <span className="mt-2.5 size-6 shrink-0 rounded-full bg-surface-2 text-center text-xs font-medium leading-6" aria-hidden>
                    {number}
                  </span>
                  <Textarea
                    value={step.instruction}
                    rows={2}
                    aria-label={t('step', { number })}
                    onChange={(e) =>
                      onStepsChange(steps.map((s) => (s.key === step.key ? { ...s, instruction: e.target.value } : s)))
                    }
                    className="min-h-11 flex-1 text-base"
                  />
                  <button
                    type="button"
                    aria-label={t('removeStep', { number })}
                    onClick={() => onStepsChange(steps.filter((s) => s.key !== step.key))}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-red-500/15 dark:hover:text-red-300"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
                {step.media.length > 0 ? (
                  <div className="flex flex-wrap gap-2 pl-8">
                    {step.media.map((m) =>
                      m.url ? (
                        // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                        <img key={m.mediaId} src={m.url} alt="" className="h-12 w-12 rounded-md border border-border object-cover" />
                      ) : null,
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
