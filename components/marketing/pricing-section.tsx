import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Reveal } from '@/components/marketing/reveal';
import { cn } from '@/lib/utils';

const PLANS = [
  { key: 'free', features: ['f1', 'f2', 'f3', 'f4'], featured: false },
  { key: 'pro', features: ['f1', 'f2', 'f3', 'f4'], featured: true },
  { key: 'business', features: ['f1', 'f2', 'f3', 'f4'], featured: false },
] as const;

export async function PricingSection() {
  const t = await getTranslations('marketing.pricing');

  return (
    <section
      id="pricing"
      className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6 md:py-28 lg:px-8"
    >
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          {t('title')}
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">{t('subtitle')}</p>
      </Reveal>

      <div className="mt-14 grid items-start gap-6 lg:grid-cols-3">
        {PLANS.map((plan, i) => (
          <Reveal key={plan.key} delay={i * 80}>
            <Card
              className={cn(
                'relative flex h-full flex-col p-7',
                plan.featured &&
                  'border-accent-500/40 shadow-xl ring-1 ring-accent-500/30 lg:-mt-4 lg:pb-11',
              )}
            >
              {plan.featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge variant="accent" className="shadow-sm">
                    {t('popular')}
                  </Badge>
                </div>
              )}

              <p className="font-display text-lg font-semibold text-foreground">
                {t(`${plan.key}.name`)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(`${plan.key}.tagline`)}
              </p>

              <div className="mt-5 flex items-baseline gap-1">
                <span className="font-display text-4xl font-bold tracking-tight text-foreground">
                  {t(`${plan.key}.price`)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t('perMonth')}
                </span>
              </div>

              <Button
                asChild
                size="lg"
                variant={plan.featured ? 'default' : 'outline'}
                className="mt-6 w-full"
              >
                <Link href="/sign-up">{t(`${plan.key}.cta`)}</Link>
              </Button>

              <ul className="mt-7 flex flex-col gap-3 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-brand-600 dark:text-brand-400"
                      aria-hidden
                    />
                    <span className="text-foreground/90">
                      {t(`${plan.key}.${f}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
