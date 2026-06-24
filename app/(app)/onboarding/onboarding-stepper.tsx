'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PricingTable } from '@clerk/nextjs';
import { Check, FileText, LineChart, Package, Utensils } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useActionError } from '@/lib/i18n/use-action-error';
import type { ActionErrorCode } from '@/lib/action-result';
import { SettingsForm, type SettingsFormValues } from '../settings/settings-form';
import { completeOnboardingAction } from './actions';

type StepKey = 'setup' | 'plan' | 'tour';
const STEP_ORDER: StepKey[] = ['setup', 'plan', 'tour'];

// The plan step renders Clerk's <PricingTable>; subscribing runs a checkout that
// navigates away and reloads the page on return, which would otherwise reset the
// stepper to step 1. Persist the current step in sessionStorage (survives the
// full-page round-trip within the tab) so the user lands back where they left off.
const STEP_STORAGE_KEY = 'prepprofit:onboarding-step';

function readInitialStep(): number {
  if (typeof window === 'undefined') return 0;
  const saved = window.sessionStorage.getItem(STEP_STORAGE_KEY) as StepKey | null;
  const index = saved == null ? -1 : STEP_ORDER.indexOf(saved);
  return index >= 0 ? index : 0;
}

const TOUR_ITEMS = [
  { key: 'recipes', href: '/recipes', icon: Utensils },
  { key: 'inventory', href: '/inventory', icon: Package },
  { key: 'financials', href: '/financials', icon: LineChart },
  { key: 'invoices', href: '/invoices', icon: FileText },
] as const;

/**
 * Client stepper driving the post-signup onboarding flow (Sprint 4d). Step state
 * is ephemeral — the only persisted signal is `completeOnboardingAction` at the
 * end, which marks the org onboarded and redirects to the dashboard. Steps:
 *   1. Business identity — reuses the Settings form (saving is optional; defaults
 *      already work). "Next" advances regardless of whether it was saved.
 *   2. Plan — reuses Clerk's <PricingTable>; Starter is the free default, so the
 *      step is skippable.
 *   3. Tour — static module links, then finish.
 */
export function OnboardingStepper({ settings }: { settings: SettingsFormValues }) {
  const t = useTranslations('onboarding');
  const actionError = useActionError();
  const [stepIndex, setStepIndex] = useState(readInitialStep);
  const [finishError, setFinishError] = useState<ActionErrorCode | null>(null);
  const [finishing, startFinish] = useTransition();

  // Keep the persisted step in sync so a checkout round-trip (or any reload)
  // restores the current step instead of snapping back to step 1.
  useEffect(() => {
    window.sessionStorage.setItem(STEP_STORAGE_KEY, STEP_ORDER[stepIndex] ?? 'setup');
  }, [stepIndex]);

  const finish = () => {
    setFinishError(null);
    startFinish(async () => {
      // On success the action redirects (the transition follows it); only a
      // refusal (e.g. forged non-manager POST) resolves to a result here.
      const result = await completeOnboardingAction();
      if (result && !result.ok) {
        setFinishError(result.code);
        return;
      }
      // Flow is done — drop the saved step so a later visit (e.g. a different org
      // in the same tab) starts clean at step 1.
      window.sessionStorage.removeItem(STEP_STORAGE_KEY);
    });
  };

  const step = STEP_ORDER[stepIndex];
  const goBack = () => setStepIndex((i) => Math.max(0, i - 1));
  const goNext = () => setStepIndex((i) => Math.min(STEP_ORDER.length - 1, i + 1));

  return (
    <div className="flex flex-col gap-6">
      {/* Step indicator */}
      <ol className="flex items-center gap-3" aria-label={t('subtitle')}>
        {STEP_ORDER.map((key, i) => {
          const done = i < stepIndex;
          const active = i === stepIndex;
          return (
            <li key={key} className="flex flex-1 items-center gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                    active && 'bg-accent-700 text-white',
                    done && 'bg-brand-600 text-white',
                    !active && !done && 'bg-surface-2 text-muted-foreground',
                  )}
                >
                  {done ? <Check className="size-4" /> : i + 1}
                </span>
                <span
                  className={cn(
                    'hidden text-sm font-medium sm:inline',
                    active ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {t(`steps.${key}`)}
                </span>
              </div>
              {i < STEP_ORDER.length - 1 && (
                <span className="h-px flex-1 bg-border" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>

      {/* Step 1 — business identity */}
      {step === 'setup' && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold text-foreground">
              {t('setup.title')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('setup.description')}</p>
          </div>
          <SettingsForm settings={settings} />
          <div className="flex justify-end">
            <Button type="button" onClick={goNext}>
              {t('nav.next')}
            </Button>
          </div>
        </div>
      )}

      {/* Step 2 — plan */}
      {step === 'plan' && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold text-foreground">
              {t('plan.title')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('plan.description')}</p>
          </div>
          <PricingTable for="organization" />
          <div className="flex justify-between">
            <Button type="button" variant="outline" onClick={goBack}>
              {t('nav.back')}
            </Button>
            <Button type="button" onClick={goNext}>
              {t('plan.continueOnStarter')}
            </Button>
          </div>
        </div>
      )}

      {/* Step 3 — tour + finish */}
      {step === 'tour' && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold text-foreground">
              {t('tour.title')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('tour.description')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {TOUR_ITEMS.map(({ key, href, icon: Icon }) => (
              <Link key={key} href={href} className="group">
                <Card className="h-full transition-colors group-hover:border-accent-400">
                  <CardContent className="flex items-start gap-3 p-5">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-accent-700">
                      <Icon className="size-5" />
                    </span>
                    <div className="flex flex-col gap-1">
                      <p className="text-sm font-semibold text-foreground">
                        {t(`tour.items.${key}.title`)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t(`tour.items.${key}.description`)}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          {finishError && (
            <p className="text-sm text-destructive" role="alert">
              {actionError(finishError)}
            </p>
          )}
          <div className="flex justify-between">
            <Button type="button" variant="outline" onClick={goBack}>
              {t('nav.back')}
            </Button>
            <Button type="button" onClick={finish} disabled={finishing}>
              {t('nav.finish')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
