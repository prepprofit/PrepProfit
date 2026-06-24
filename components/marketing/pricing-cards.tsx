'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Reveal } from '@/components/marketing/reveal';
import { cn } from '@/lib/utils';

export interface PricingPlan {
  key: string;
  name: string;
  tagline: string;
  priceMonth: string;
  priceYear: string;
  cta: string;
  features: string[];
  /** Filled accent card (first plan, like the template's coloured card). */
  filled?: boolean;
  /** "Most popular" emphasis. */
  popular?: boolean;
}

export interface PricingLabels {
  monthly: string;
  yearly: string;
  save: string;
  perMonth: string;
  perYear: string;
  billedYearly: string;
  popular: string;
}

export function PricingCards({
  plans,
  labels,
}: {
  plans: PricingPlan[];
  labels: PricingLabels;
}) {
  const [yearly, setYearly] = React.useState(false);

  return (
    <>
      {/* Billing period toggle */}
      <Reveal className="mt-8 flex items-center justify-center">
        <div className="inline-flex items-center gap-1 rounded-full border border-border bg-surface p-1">
          <button
            type="button"
            onClick={() => setYearly(false)}
            aria-pressed={!yearly}
            className={cn(
              'cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              !yearly
                ? 'bg-accent-700 text-white shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {labels.monthly}
          </button>
          <button
            type="button"
            onClick={() => setYearly(true)}
            aria-pressed={yearly}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              yearly
                ? 'bg-accent-700 text-white shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {labels.yearly}
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[11px] font-semibold',
                yearly
                  ? 'bg-white/20 text-white'
                  : 'bg-brand-500/15 text-brand-600 dark:text-brand-400',
              )}
            >
              {labels.save}
            </span>
          </button>
        </div>
      </Reveal>

      <div className="mt-12 grid items-start gap-6 lg:grid-cols-3">
        {plans.map((plan, i) => {
          const price = yearly ? plan.priceYear : plan.priceMonth;
          const unit = yearly ? labels.perYear : labels.perMonth;
          return (
            <Reveal key={plan.key} delay={i * 80}>
              <Card
                className={cn(
                  'relative flex h-full flex-col p-7',
                  plan.filled &&
                    'border-transparent bg-gradient-to-br from-accent-600 to-accent-700 text-white shadow-xl',
                  plan.popular &&
                    'border-accent-500/40 shadow-xl ring-1 ring-accent-500/30 lg:-mt-4 lg:pb-11',
                )}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge variant="accent" className="shadow-sm">
                      {labels.popular}
                    </Badge>
                  </div>
                )}

                <p
                  className={cn(
                    'font-display text-lg font-semibold',
                    plan.filled ? 'text-white' : 'text-foreground',
                  )}
                >
                  {plan.name}
                </p>
                <p
                  className={cn(
                    'mt-1 text-sm',
                    plan.filled ? 'text-white/80' : 'text-muted-foreground',
                  )}
                >
                  {plan.tagline}
                </p>

                <div className="mt-5 flex items-baseline gap-1">
                  <span
                    className={cn(
                      'font-display text-4xl font-bold tracking-tight tabular-nums',
                      plan.filled ? 'text-white' : 'text-foreground',
                    )}
                  >
                    {price}
                  </span>
                  <span
                    className={cn(
                      'text-sm',
                      plan.filled ? 'text-white/80' : 'text-muted-foreground',
                    )}
                  >
                    {unit}
                  </span>
                </div>
                <p
                  className={cn(
                    'mt-1 h-4 text-xs',
                    plan.filled ? 'text-white/70' : 'text-muted-foreground',
                  )}
                >
                  {yearly ? labels.billedYearly : ''}
                </p>

                <Button
                  asChild
                  size="lg"
                  variant={plan.popular ? 'default' : 'outline'}
                  className={cn(
                    'mt-6 w-full',
                    plan.filled &&
                      'border-transparent bg-white text-accent-700 hover:bg-white/90',
                  )}
                >
                  <Link href="/sign-up">{plan.cta}</Link>
                </Button>

                <ul className="mt-7 flex flex-col gap-3 text-sm">
                  {plan.features.map((f, fi) => (
                    <li key={fi} className="flex items-start gap-3">
                      <Check
                        className={cn(
                          'mt-0.5 size-4 shrink-0',
                          plan.filled
                            ? 'text-white'
                            : 'text-brand-600 dark:text-brand-400',
                        )}
                        aria-hidden
                      />
                      <span
                        className={
                          plan.filled ? 'text-white/90' : 'text-foreground/90'
                        }
                      >
                        {f}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </Reveal>
          );
        })}
      </div>
    </>
  );
}
