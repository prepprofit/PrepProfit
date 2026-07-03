'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import NumberFlow from '@number-flow/react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Reveal } from '@/components/marketing/reveal';
import { cn } from '@/lib/utils';

export interface PricingPlan {
  key: string;
  name: string;
  tagline: string;
  /** Numeric prices so NumberFlow can animate the monthly/yearly change. */
  priceMonth: number;
  priceYear: number;
  cta: string;
  features: string[];
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
  currency: string;
}

/**
 * Template's "ruixen" pricing tiers: outer card with a padded glass header
 * panel (name, NumberFlow-animated price, CTA) and the feature list below,
 * toggled between monthly and yearly with a labelled switch.
 */
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
      <Reveal className="mt-8 flex items-center justify-center gap-3">
        <Label
          htmlFor="billing-toggle"
          className={cn(
            'cursor-pointer text-sm transition-colors',
            !yearly ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {labels.monthly}
        </Label>
        <Switch
          id="billing-toggle"
          checked={yearly}
          onCheckedChange={setYearly}
        />
        <Label
          htmlFor="billing-toggle"
          className={cn(
            'cursor-pointer text-sm transition-colors',
            yearly ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {labels.yearly}
          <span className="ml-1.5 rounded-full bg-brand-500/15 px-2 py-0.5 text-xs font-semibold text-brand-600 dark:text-brand-400">
            {labels.save}
          </span>
        </Label>
      </Reveal>

      <div className="mt-12 grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan, i) => (
          <Reveal key={plan.key} delay={i * 80} className="h-full">
            <Card
              className={cn(
                'relative flex h-full flex-col rounded-2xl p-1.5 shadow-md',
                plan.popular &&
                  'border-accent-500/40 shadow-xl ring-1 ring-accent-500/30',
              )}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 z-10 -translate-x-1/2">
                  <Badge variant="accent" className="shadow-sm">
                    {labels.popular}
                  </Badge>
                </div>
              )}

              {/* Header panel (template's glass header) */}
              <div className="relative overflow-hidden rounded-xl border border-border bg-surface-2/70 p-4">
                <div
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-32 rounded-[inherit] bg-gradient-to-b from-white/40 via-white/10 to-transparent dark:from-white/[0.06] dark:via-white/[0.02]"
                />
                <div className="relative">
                  <p className="font-display text-sm font-semibold text-foreground">
                    {plan.name}
                  </p>
                  <div className="mt-2 flex items-end gap-1">
                    <span className="font-display text-3xl font-extrabold tracking-tight tabular-nums text-foreground">
                      {labels.currency}
                      <NumberFlow
                        value={yearly ? plan.priceYear : plan.priceMonth}
                      />
                    </span>
                    <span className="pb-1 text-sm text-muted-foreground">
                      {yearly ? labels.perYear : labels.perMonth}
                    </span>
                  </div>
                  <p className="mt-0.5 h-4 text-xs text-muted-foreground">
                    {yearly ? labels.billedYearly : ''}
                  </p>
                  <p className="mt-2 min-h-10 text-sm text-muted-foreground">
                    {plan.tagline}
                  </p>
                  <Button
                    asChild
                    variant={plan.popular ? 'default' : 'outline'}
                    className="mt-4 w-full"
                  >
                    <Link href="/sign-up">{plan.cta}</Link>
                  </Button>
                </div>
              </div>

              {/* Feature list */}
              <ul className="flex flex-col gap-3 p-4 text-sm">
                {plan.features.map((f, fi) => (
                  <li key={fi} className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-brand-600 dark:text-brand-400"
                      aria-hidden
                    />
                    <span className="text-foreground/90">{f}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </Reveal>
        ))}
      </div>
    </>
  );
}
