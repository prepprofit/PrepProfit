import { getTranslations } from 'next-intl/server';
import { Reveal } from '@/components/marketing/reveal';
import {
  PricingCards,
  type PricingPlan,
} from '@/components/marketing/pricing-cards';

const PLAN_KEYS = ['free', 'solo', 'pro', 'business'] as const;
const FEATURE_KEYS = ['f1', 'f2', 'f3', 'f4'] as const;

/** The message strings ("$19") stay the single source; NumberFlow needs numbers. */
function priceValue(message: string): number {
  const parsed = Number(message.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function PricingSection() {
  const t = await getTranslations('marketing.pricing');

  const plans: PricingPlan[] = PLAN_KEYS.map((key) => ({
    key,
    name: t(`${key}.name`),
    tagline: t(`${key}.tagline`),
    priceMonth: priceValue(t(`${key}.price`)),
    priceYear: priceValue(t(`${key}.priceYear`)),
    cta: t(`${key}.cta`),
    features: FEATURE_KEYS.map((f) => t(`${key}.${f}`)),
    popular: key === 'pro',
  }));

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

      <PricingCards
        plans={plans}
        labels={{
          monthly: t('toggle.monthly'),
          yearly: t('toggle.yearly'),
          save: t('toggle.save'),
          perMonth: t('perMonth'),
          perYear: t('perYear'),
          billedYearly: t('billedYearly'),
          popular: t('popular'),
          currency: t('currency'),
        }}
      />
    </section>
  );
}
