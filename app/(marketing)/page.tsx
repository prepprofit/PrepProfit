import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  Calculator,
  LineChart,
  ReceiptText,
  Sparkles,
  ShieldCheck,
  ChefHat,
  Croissant,
  CakeSlice,
  Coffee,
  Truck,
  UtensilsCrossed,
  Check,
  X,
  ArrowRight,
  Quote,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { MarketingHeader } from '@/components/marketing/marketing-header';
import { AppPreview } from '@/components/marketing/app-preview';
import { PricingSection } from '@/components/marketing/pricing-section';
import { FaqSection } from '@/components/marketing/faq-section';
import { Reveal } from '@/components/marketing/reveal';

const AUDIENCE = [
  { key: 'restaurants', Icon: UtensilsCrossed },
  { key: 'bakeries', Icon: Croissant },
  { key: 'patisseries', Icon: CakeSlice },
  { key: 'cafes', Icon: Coffee },
  { key: 'foodTrucks', Icon: Truck },
  { key: 'catering', Icon: ChefHat },
] as const;

const HOW_STEPS = ['step1', 'step2', 'step3'] as const;
const TESTIMONIALS = ['a', 'b', 'c'] as const;

export default async function MarketingPage() {
  const t = await getTranslations('marketing');
  const tApp = await getTranslations('app');
  const productName = tApp('name');

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-background">
      <MarketingHeader productName={productName} />

      <main className="flex-1">
        {/* ---------------------------------------------------------------- */}
        {/* Hero — asymmetric split: copy left, real product preview right     */}
        {/* ---------------------------------------------------------------- */}
        <section className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px]"
            style={{
              background:
                'radial-gradient(55% 55% at 50% -5%, color-mix(in oklab, var(--color-accent-500) 14%, transparent), transparent)',
            }}
          />
          <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 pt-14 pb-20 sm:px-6 md:pt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-8 lg:px-8 lg:pb-28">
            <Reveal>
              <Badge variant="accent">{t('hero.eyebrow')}</Badge>
              <h1 className="mt-5 font-display text-4xl font-bold leading-[1.05] tracking-tight text-foreground sm:text-5xl lg:text-6xl">
                {t('hero.headline')}
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
                {t('hero.subhead')}
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button asChild size="lg">
                  <Link href="/sign-up">
                    {t('hero.ctaPrimary')}
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/sign-in">{t('hero.ctaSecondary')}</Link>
                </Button>
              </div>
            </Reveal>

            <Reveal delay={120} className="lg:pl-4">
              <AppPreview />
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Audience strip (under-hero credibility, honest segments)          */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-y border-border bg-surface/50">
          <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
            <div className="flex flex-col items-center gap-6 lg:flex-row lg:justify-between">
              <p className="text-sm font-medium text-muted-foreground">
                {t('audience.lead')}
              </p>
              <ul className="flex flex-wrap items-center justify-center gap-x-7 gap-y-4">
                {AUDIENCE.map(({ key, Icon }) => (
                  <li
                    key={key}
                    className="flex items-center gap-2 text-sm font-medium text-foreground/80"
                  >
                    <Icon
                      className="size-4 text-accent-500"
                      aria-hidden
                    />
                    {t(`audience.${key}`)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Problem -> Solution (two-column contrast)                         */}
        {/* ---------------------------------------------------------------- */}
        <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
              {t('problem.title')}
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              {t('problem.subtitle')}
            </p>
          </Reveal>

          <div className="mx-auto mt-14 grid max-w-4xl gap-6 md:grid-cols-2">
            <Reveal>
              <Card className="h-full bg-surface-2/60 p-7">
                <h3 className="font-display text-base font-semibold text-foreground">
                  {t('problem.beforeTitle')}
                </h3>
                <ul className="mt-5 flex flex-col gap-4">
                  {(['a', 'b', 'c', 'd'] as const).map((k) => (
                    <li
                      key={k}
                      className="flex items-start gap-3 text-sm text-muted-foreground"
                    >
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
                        <X className="size-3" aria-hidden />
                      </span>
                      {t(`problem.before.${k}`)}
                    </li>
                  ))}
                </ul>
              </Card>
            </Reveal>

            <Reveal delay={100}>
              <Card className="h-full border-brand-500/30 bg-brand-50/40 p-7 dark:bg-brand-500/5">
                <h3 className="font-display text-base font-semibold text-foreground">
                  {t('problem.afterTitle')}
                </h3>
                <ul className="mt-5 flex flex-col gap-4">
                  {(['a', 'b', 'c', 'd'] as const).map((k) => (
                    <li
                      key={k}
                      className="flex items-start gap-3 text-sm text-foreground/90"
                    >
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-600 dark:text-brand-400">
                        <Check className="size-3" aria-hidden />
                      </span>
                      {t(`problem.after.${k}`)}
                    </li>
                  ))}
                </ul>
              </Card>
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Features — asymmetric bento grid                                  */}
        {/* ---------------------------------------------------------------- */}
        <section
          id="features"
          className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6 md:py-28 lg:px-8"
        >
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
              {t('features.title')}
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              {t('features.subtitle')}
            </p>
          </Reveal>

          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {/* Lead tile — spans two columns with accent treatment */}
            <Reveal className="md:col-span-2">
              <Card className="relative h-full overflow-hidden p-8">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full opacity-60 blur-3xl"
                  style={{
                    background:
                      'radial-gradient(circle, color-mix(in oklab, var(--color-accent-500) 26%, transparent), transparent 70%)',
                  }}
                />
                <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent-500/12 text-accent-600 dark:text-accent-400">
                  <Calculator className="size-5" aria-hidden />
                </div>
                <h3 className="font-display text-xl font-semibold text-foreground">
                  {t('features.costing.title')}
                </h3>
                <p className="mt-3 max-w-lg text-muted-foreground">
                  {t('features.costing.body')}
                </p>
              </Card>
            </Reveal>

            <Reveal delay={80}>
              <FeatureTile
                Icon={LineChart}
                title={t('features.financials.title')}
                body={t('features.financials.body')}
              />
            </Reveal>
            <Reveal delay={80}>
              <FeatureTile
                Icon={ReceiptText}
                title={t('features.operations.title')}
                body={t('features.operations.body')}
              />
            </Reveal>
            <Reveal delay={160}>
              <FeatureTile
                Icon={Sparkles}
                title={t('features.ai.title')}
                body={t('features.ai.body')}
              />
            </Reveal>

            {/* Security tile — spans full width on its row, tinted */}
            <Reveal delay={160} className="md:col-span-1">
              <Card className="flex h-full flex-col justify-between bg-surface-2/60 p-7">
                <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-brand-500/12 text-brand-600 dark:text-brand-400">
                  <ShieldCheck className="size-5" aria-hidden />
                </div>
                <div>
                  <h3 className="font-display text-base font-semibold text-foreground">
                    {t('features.security.title')}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t('features.security.body')}
                  </p>
                </div>
              </Card>
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* How it works — 3 verb-led steps on a connecting line              */}
        {/* ---------------------------------------------------------------- */}
        <section
          id="how-it-works"
          className="scroll-mt-20 border-y border-border bg-surface/40"
        >
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
            <Reveal className="mx-auto max-w-2xl text-center">
              <h2 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
                {t('how.title')}
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                {t('how.subtitle')}
              </p>
            </Reveal>

            <div className="mt-14 grid gap-8 md:grid-cols-3">
              {HOW_STEPS.map((step, i) => (
                <Reveal key={step} delay={i * 100}>
                  <div className="flex flex-col">
                    <div className="flex size-10 items-center justify-center rounded-full bg-accent-700 font-display text-sm font-semibold text-white">
                      {i + 1}
                    </div>
                    <h3 className="mt-5 font-display text-lg font-semibold text-foreground">
                      {t(`how.${step}.title`)}
                    </h3>
                    <p className="mt-2 text-muted-foreground">
                      {t(`how.${step}.body`)}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Pricing                                                          */}
        {/* ---------------------------------------------------------------- */}
        <PricingSection />

        {/* ---------------------------------------------------------------- */}
        {/* Testimonials (placeholder copy — replace with real quotes)        */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-t border-border bg-surface/40">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
            <Reveal className="mx-auto max-w-2xl text-center">
              <h2 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
                {t('testimonials.title')}
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                {t('testimonials.subtitle')}
              </p>
            </Reveal>

            <div className="mt-14 grid gap-6 md:grid-cols-3">
              {TESTIMONIALS.map((key, i) => (
                <Reveal key={key} delay={i * 90}>
                  <Card className="flex h-full flex-col p-7">
                    <Quote
                      className="size-7 text-accent-500/40"
                      aria-hidden
                    />
                    <blockquote className="mt-4 flex-1 text-[15px] leading-relaxed text-foreground/90">
                      {t(`testimonials.${key}.quote`)}
                    </blockquote>
                    <figcaption className="mt-6 border-t border-border pt-4">
                      <p className="font-display text-sm font-semibold text-foreground">
                        {t(`testimonials.${key}.name`)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t(`testimonials.${key}.role`)}
                      </p>
                    </figcaption>
                  </Card>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* FAQ                                                              */}
        {/* ---------------------------------------------------------------- */}
        <FaqSection />

        {/* ---------------------------------------------------------------- */}
        {/* Final CTA band                                                   */}
        {/* ---------------------------------------------------------------- */}
        <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
          <Reveal>
            <Card className="relative overflow-hidden border-transparent bg-gradient-to-br from-accent-600 to-accent-700 px-6 py-16 text-center shadow-xl">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 opacity-30"
                style={{
                  background:
                    'radial-gradient(40% 60% at 50% 0%, rgba(255,255,255,0.5), transparent)',
                }}
              />
              <div className="relative mx-auto flex max-w-xl flex-col items-center gap-5">
                <h2 className="font-display text-3xl font-bold tracking-tight text-white md:text-4xl">
                  {t('ctaBand.title')}
                </h2>
                <p className="text-white/90">{t('ctaBand.subtitle')}</p>
                <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                  <Button
                    asChild
                    size="lg"
                    className="bg-white text-accent-700 hover:bg-white/90"
                  >
                    <Link href="/sign-up">
                      {t('ctaBand.action')}
                      <ArrowRight className="size-4" aria-hidden />
                    </Link>
                  </Button>
                  <Button
                    asChild
                    size="lg"
                    variant="ghost"
                    className="text-white hover:bg-white/15 hover:text-white"
                  >
                    <Link href="/sign-in">{t('ctaBand.secondary')}</Link>
                  </Button>
                </div>
              </div>
            </Card>
          </Reveal>
        </section>
      </main>

      {/* ------------------------------------------------------------------ */}
      {/* Footer                                                             */}
      {/* ------------------------------------------------------------------ */}
      <footer className="border-t border-border bg-surface/40">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
          <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr]">
            <div className="max-w-sm">
              <p className="font-display text-lg font-semibold text-foreground">
                {productName}
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                {t('footer.tagline')}
              </p>
            </div>

            <div>
              <p className="font-display text-sm font-semibold text-foreground">
                {t('footer.productTitle')}
              </p>
              <ul className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
                <li>
                  <a href="#features" className="hover:text-foreground">
                    {t('nav.features')}
                  </a>
                </li>
                <li>
                  <a href="#pricing" className="hover:text-foreground">
                    {t('nav.pricing')}
                  </a>
                </li>
                <li>
                  <a href="#faq" className="hover:text-foreground">
                    {t('nav.faq')}
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <p className="font-display text-sm font-semibold text-foreground">
                {t('footer.accountTitle')}
              </p>
              <ul className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground">
                <li>
                  <Link href="/sign-in" className="hover:text-foreground">
                    {t('nav.signIn')}
                  </Link>
                </li>
                <li>
                  <Link href="/sign-up" className="hover:text-foreground">
                    {t('nav.getStarted')}
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row">
            <span>
              © {new Date().getFullYear()} {productName}. {t('footer.rights')}
            </span>
            <span>{t('footer.note')}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureTile({
  Icon,
  title,
  body,
}: {
  Icon: typeof Calculator;
  title: string;
  body: string;
}) {
  return (
    <Card className="h-full p-7">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent-500/12 text-accent-600 dark:text-accent-400">
        <Icon className="size-5" aria-hidden />
      </div>
      <h3 className="font-display text-base font-semibold text-foreground">
        {title}
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </Card>
  );
}
