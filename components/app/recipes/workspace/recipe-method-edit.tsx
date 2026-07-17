'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { RecipeMediaUpload } from './recipe-media-upload';

/**
 * Editable prep method (Fase 3 slice 2): mirrors the ingredient edit list —
 * client model maps 1:1 to the save draft (`methodSections`/`steps`), array
 * position is the persisted order, new sections get a `tmp-…` ref used as
 * tempId. Step text is plain TEXT end-to-end.
 */
export type DraftMethodSection = { ref: string; id?: string; title: string };

export type DraftStepMedia = { mediaId: string; url: string | null };

export type DraftStep = {
  key: string;
  id?: string;
  instruction: string;
  sectionRef: string | null;
  /** Attached READY media in display order (uploaded via the media routes). */
  media: DraftStepMedia[];
};

export function RecipeMethodEdit({
  recipeId,
  sections,
  steps,
  onSectionsChange,
  onStepsChange,
}: {
  recipeId: string;
  sections: DraftMethodSection[];
  steps: DraftStep[];
  onSectionsChange: (sections: DraftMethodSection[]) => void;
  onStepsChange: (steps: DraftStep[]) => void;
}) {
  const t = useTranslations('recipes.workspace');

  const moveStep = (index: number, delta: -1 | 1) => {
    const next = [...steps];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [step] = next.splice(index, 1);
    next.splice(target, 0, step!);
    onStepsChange(next);
  };

  const updateStep = (key: string, patch: Partial<DraftStep>) => {
    onStepsChange(steps.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  };

  const addStep = () => {
    onStepsChange([
      ...steps,
      {
        key: `new-${crypto.randomUUID()}`,
        instruction: '',
        sectionRef: null,
        media: [],
      },
    ]);
  };

  const addSection = () => {
    onSectionsChange([
      ...sections,
      { ref: `tmp-${crypto.randomUUID()}`, title: '' },
    ]);
  };

  const removeSection = (ref: string) => {
    onSectionsChange(sections.filter((s) => s.ref !== ref));
    onStepsChange(
      steps.map((s) => (s.sectionRef === ref ? { ...s, sectionRef: null } : s)),
    );
  };

  const sectionSelectOptions = [
    { value: '', label: t('defaultSection') },
    ...sections.map((s) => ({ value: s.ref, label: s.title || '…' })),
  ];

  return (
    <div className="flex flex-col gap-4">
      {sections.map((section) => (
        <div key={section.ref} className="flex items-center gap-2">
          <Input
            value={section.title}
            onChange={(e) =>
              onSectionsChange(
                sections.map((s) =>
                  s.ref === section.ref ? { ...s, title: e.target.value } : s,
                ),
              )
            }
            placeholder={t('sectionTitlePlaceholder')}
            className="h-8 max-w-xs"
            aria-label={t('sectionTitlePlaceholder')}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => removeSection(section.ref)}
            aria-label={t('removeSection')}
          >
            <Trash2 />
          </Button>
        </div>
      ))}

      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={step.key}
            className="flex flex-wrap items-start gap-2 rounded-lg border border-border bg-surface p-2"
          >
            <span className="mt-2 size-6 shrink-0 rounded-full bg-surface-2 text-center text-xs font-medium leading-6">
              {index + 1}
            </span>
            <Textarea
              value={step.instruction}
              onChange={(e) =>
                updateStep(step.key, { instruction: e.target.value })
              }
              placeholder={t('method.stepPlaceholder')}
              rows={2}
              className="min-h-9 min-w-48 flex-1"
              aria-label={t('method.step', { number: index + 1 })}
            />
            <div className="flex w-full flex-wrap items-center gap-2 pl-8">
              {step.media.map((m) => (
                <span key={m.mediaId} className="relative">
                  {m.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                    <img
                      src={m.url}
                      alt=""
                      className="h-14 w-14 rounded-md border border-border object-cover"
                    />
                  ) : (
                    <span className="flex h-14 w-14 items-center justify-center rounded-md border border-border bg-surface-2 text-xs text-muted-foreground">
                      …
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      updateStep(step.key, {
                        media: step.media.filter(
                          (x) => x.mediaId !== m.mediaId,
                        ),
                      })
                    }
                    aria-label={t('media.removeMedia')}
                    className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] leading-none text-background"
                  >
                    ×
                  </button>
                </span>
              ))}
              <RecipeMediaUpload
                recipeId={recipeId}
                onUploaded={(m) =>
                  updateStep(step.key, {
                    media: [...step.media, { mediaId: m.mediaId, url: m.url }],
                  })
                }
              />
            </div>
            <Select
              value={step.sectionRef ?? ''}
              onChange={(e) =>
                updateStep(step.key, {
                  sectionRef: e.target.value === '' ? null : e.target.value,
                })
              }
              className="h-8 w-36"
              aria-label={t('addSection')}
            >
              {sectionSelectOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => moveStep(index, -1)}
                disabled={index === 0}
                aria-label={t('moveUp')}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => moveStep(index, 1)}
                disabled={index === steps.length - 1}
                aria-label={t('moveDown')}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  onStepsChange(steps.filter((s) => s.key !== step.key))
                }
                aria-label={t('method.removeStep')}
              >
                <Trash2 />
              </Button>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={addStep}>
          <Plus /> {t('method.addStep')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={addSection}>
          <Plus /> {t('addSection')}
        </Button>
      </div>
    </div>
  );
}
