import Link from 'next/link';
import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import {
  ChefHat,
  Croissant,
  CakeSlice,
  Coffee,
  Truck,
  UtensilsCrossed,
  ArrowRight,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MarketingHeader } from '@/components/marketing/marketing-header';
import { AppPreview } from '@/components/marketing/app-preview';
import { IntroSection } from '@/components/marketing/intro-section';
import { FeatureCards } from '@/components/marketing/feature-cards';
import { ImportExportSection } from '@/components/marketing/import-export-section';
import { PricingSection } from '@/components/marketing/pricing-section';
import { TestimonialFeature } from '@/components/marketing/testimonial-feature';
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

export default async function MarketingPage() {
  const t = await getTranslations('marketing');
  const tApp = await getTranslations('app');
  const productName = tApp('name');

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-background">
      <MarketingHeader productName={productName} />

      <main className="flex-1">
        {/* ---------------------------------------------------------------- */}
        {/* Hero — centered copy with a full-width product preview below       */}
        {/* ---------------------------------------------------------------- */}
        <section className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[680px]"
            style={{
              background:
                'radial-gradient(60% 60% at 50% -10%, color-mix(in oklab, var(--color-accent-500) 14%, transparent), transparent)',
            }}
          />
          <div className="mx-auto max-w-7xl px-4 pt-16 sm:px-6 md:pt-24 lg:px-8">
            <Reveal className="mx-auto flex max-w-3xl flex-col items-center text-center">
              <Badge variant="accent">{t('hero.eyebrow')}</Badge>
              <h1 className="mt-6 font-display text-4xl font-bold leading-[1.05] tracking-tight text-foreground sm:text-5xl lg:text-6xl">
                {t('hero.headline')}
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
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

            <Reveal
              delay={140}
              className="mx-auto mt-16 max-w-5xl pb-20 md:pb-28"
            >
              <AppPreview />
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Segment strip (honest, replaces the template's customer logos)    */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-y border-border bg-surface/50">
          <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
            <div className="flex flex-col items-center gap-6">
              <p className="text-sm font-medium text-muted-foreground">
                {t('audience.lead')}
              </p>
              <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
                {AUDIENCE.map(({ key, Icon }) => (
                  <li
                    key={key}
                    className="flex items-center gap-2 text-sm font-medium text-foreground/80"
                  >
                    <Icon className="size-4 text-accent-500" aria-hidden />
                    {t(`audience.${key}`)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* "Everything you need" intro                                       */}
        {/* ---------------------------------------------------------------- */}
        <IntroSection />

        {/* ---------------------------------------------------------------- */}
        {/* Feature cards                                                     */}
        {/* ---------------------------------------------------------------- */}
        <FeatureCards />

        {/* ---------------------------------------------------------------- */}
        {/* How it works                                                      */}
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
        {/* Import & export (replaces template's integrations)                */}
        {/* ---------------------------------------------------------------- */}
        <ImportExportSection />

        {/* ---------------------------------------------------------------- */}
        {/* Pricing                                                          */}
        {/* ---------------------------------------------------------------- */}
        <PricingSection />

        {/* ---------------------------------------------------------------- */}
        {/* Featured testimonial                                             */}
        {/* ---------------------------------------------------------------- */}
        <TestimonialFeature which="a" tinted />

        {/* ---------------------------------------------------------------- */}
        {/* FAQ                                                              */}
        {/* ---------------------------------------------------------------- */}
        <FaqSection />

        {/* ---------------------------------------------------------------- */}
        {/* Second testimonial                                               */}
        {/* ---------------------------------------------------------------- */}
        <TestimonialFeature which="c" tinted />

        {/* ---------------------------------------------------------------- */}
        {/* Dark CTA band                                                    */}
        {/* ---------------------------------------------------------------- */}
        <section className="bg-[#0a0a0b] text-white">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
            <Reveal className="relative mx-auto flex max-w-2xl flex-col items-center text-center">
              <div
                aria-hidden
                className="pointer-events-none absolute -top-24 left-1/2 -z-0 size-72 -translate-x-1/2 rounded-full opacity-40 blur-3xl"
                style={{
                  background:
                    'radial-gradient(circle, color-mix(in oklab, var(--color-accent-500) 60%, transparent), transparent 70%)',
                }}
              />
              <span className="relative inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-white/80">
                {t('subscribe.eyebrow')}
              </span>
              <h2 className="relative mt-6 font-display text-3xl font-bold tracking-tight text-white md:text-4xl">
                {t('subscribe.title')}{' '}
                <span className="text-accent-400">
                  {t('subscribe.titleAccent')}
                </span>
              </h2>
              <p className="relative mt-5 text-white/70">
                {t('subscribe.subtitle')}
              </p>
              <div className="relative mt-8 flex flex-col gap-3 sm:flex-row">
                <Button
                  asChild
                  size="lg"
                  className="bg-white text-accent-700 hover:bg-white/90"
                >
                  <Link href="/sign-up">
                    {t('subscribe.action')}
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="ghost"
                  className="text-white hover:bg-white/10 hover:text-white"
                >
                  <Link href="/sign-in">{t('subscribe.secondary')}</Link>
                </Button>
              </div>
              <div className="relative mt-8 flex items-center gap-2">
                <span className="flex items-center gap-1" aria-hidden>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={i}
                      className="size-4 fill-accent-400 text-accent-400"
                    />
                  ))}
                </span>
                <span className="text-sm text-white/60">
                  {t('subscribe.rating')}
                </span>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ------------------------------------------------------------------ */}
      {/* Footer (dark, like the template)                                   */}
      {/* ------------------------------------------------------------------ */}
      <footer className="bg-[#0a0a0b] text-white">
        <div className="mx-auto max-w-7xl border-t border-white/10 px-4 py-14 sm:px-6 lg:px-8">
          <div className="grid gap-10 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
            <div className="max-w-sm">
              <Image
                src="/logo-white.webp"
                alt={productName}
                width={512}
                height={113}
                className="h-8 w-auto"
              />
              <p className="mt-4 text-sm text-white/60">{t('footer.tagline')}</p>
              <a
                href="mailto:info@prepprofit.com"
                className="mt-4 inline-block text-sm text-white/80 hover:text-white"
              >
                info@prepprofit.com
              </a>
            </div>

            <div>
              <p className="font-display text-sm font-semibold text-white">
                {t('footer.productTitle')}
              </p>
              <ul className="mt-4 flex flex-col gap-3 text-sm text-white/60">
                <li>
                  <a href="#features" className="hover:text-white">
                    {t('nav.features')}
                  </a>
                </li>
                <li>
                  <a href="#pricing" className="hover:text-white">
                    {t('nav.pricing')}
                  </a>
                </li>
                <li>
                  <a href="#faq" className="hover:text-white">
                    {t('nav.faq')}
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <p className="font-display text-sm font-semibold text-white">
                {t('footer.accountTitle')}
              </p>
              <ul className="mt-4 flex flex-col gap-3 text-sm text-white/60">
                <li>
                  <Link href="/sign-in" className="hover:text-white">
                    {t('nav.signIn')}
                  </Link>
                </li>
                <li>
                  <Link href="/sign-up" className="hover:text-white">
                    {t('nav.getStarted')}
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <p className="font-display text-sm font-semibold text-white">
                {t('footer.legalTitle')}
              </p>
              <ul className="mt-4 flex flex-col gap-3 text-sm text-white/60">
                <li>
                  <a
                    href="mailto:info@prepprofit.com"
                    className="hover:text-white"
                  >
                    {t('footer.contact')}
                  </a>
                </li>
                <li>
                  <span className="text-white/40">{t('footer.privacy')}</span>
                </li>
                <li>
                  <span className="text-white/40">{t('footer.terms')}</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-white/10 pt-6 text-sm text-white/50 sm:flex-row">
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
