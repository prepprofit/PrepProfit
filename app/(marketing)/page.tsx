import Link from 'next/link';
import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { ArrowRight, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarketingHeader } from '@/components/marketing/marketing-header';
import { AppPreview } from '@/components/marketing/app-preview';
import { HeroVideo } from '@/components/marketing/hero-video';
import { FeaturedBento } from '@/components/marketing/featured-bento';
import { ProductTour } from '@/components/marketing/product-tour';
import { PricingSection } from '@/components/marketing/pricing-section';
import { TestimonialsMarquee } from '@/components/marketing/testimonials-marquee';
import { FaqSection } from '@/components/marketing/faq-section';
import { Reveal } from '@/components/marketing/reveal';

const AUDIENCE = [
  { key: 'restaurants', icon: '/icons/restaurants.webp' },
  { key: 'bakeries', icon: '/icons/bakeries.webp' },
  { key: 'patisseries', icon: '/icons/patisseries.webp' },
  { key: 'cafes', icon: '/icons/cafes.webp' },
  { key: 'chefs', icon: '/icons/chefs.webp' },
  { key: 'catering', icon: '/icons/catering.webp' },
] as const;

const TOUR_TABS = [
  { key: 'dashboard', src: '/screenshots/dashboard.webp' },
  { key: 'costing', src: '/screenshots/recipe-costing.webp' },
  { key: 'insights', src: '/screenshots/insights.webp' },
  { key: 'breakeven', src: '/screenshots/break-even.webp' },
] as const;

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
        {/* hero-wash paints the brand-accent watercolor as the section's own
            background (see globals.css): centered lobes on mobile/tablet, and
            top-corner lobes on desktop to match the template's blur pattern. */}
        <section className="relative hero-wash">
          <div className="mx-auto max-w-7xl px-4 pt-32 sm:px-6 md:pt-52 lg:px-8">
            {/* No entrance animation above the fold — static, no ease-out. */}
            <div className="mx-auto flex max-w-4xl flex-col items-center text-center lg:max-w-6xl">
              <h1 className="font-display text-4xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-7xl lg:text-6xl">
                {t('hero.headline')}
                <span className="block text-muted-foreground">
                  {t('hero.headline2')}
                </span>
              </h1>
              <p className="mt-6 max-w-lg text-lg leading-6 tracking-tight text-muted-foreground sm:text-xl lg:max-w-2xl">
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
            </div>

            <div className="mx-auto mt-16 max-w-6xl pb-20 md:pb-28">
              <HeroVideo
                labels={{
                  playVideo: t('hero.playVideo'),
                  comingSoon: t('hero.videoComingSoon'),
                  comingSoonHint: t('hero.videoComingSoonHint'),
                }}
              >
                <AppPreview />
              </HeroVideo>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Segment strip (honest, replaces the template's customer logos)    */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-y border-border bg-surface/50">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-24 lg:px-8">
            <Reveal className="mx-auto max-w-2xl text-center">
              <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
                {t('audience.title')}
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                {t('audience.subtitle')}
              </p>
            </Reveal>

            <Reveal className="mx-auto mt-12 grid max-w-5xl grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6">
              {AUDIENCE.map(({ key, icon }) => (
                <div
                  key={key}
                  className="group flex flex-col items-center gap-3 rounded-2xl border border-transparent bg-background/40 p-5 transition-all duration-300 ease-out hover:-translate-y-1.5 hover:border-border hover:bg-background hover:shadow-lg"
                >
                  <Image
                    src={icon}
                    alt=""
                    width={72}
                    height={72}
                    className="size-16 object-contain drop-shadow-sm transition-transform duration-300 ease-out group-hover:scale-110"
                    aria-hidden
                  />
                  <span className="text-sm font-medium text-foreground/80 transition-colors group-hover:text-foreground">
                    {t(`audience.${key}`)}
                  </span>
                </div>
              ))}
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Bento feature grid (absorbs intro, feature cards, import/export)  */}
        {/* ---------------------------------------------------------------- */}
        <FeaturedBento />

        {/* ---------------------------------------------------------------- */}
        {/* How it works                                                      */}
        {/* ---------------------------------------------------------------- */}
        <section
          id="how-it-works"
          className="scroll-mt-20 border-y border-border bg-surface/40"
        >
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
            <Reveal className="mx-auto max-w-2xl text-center">
              <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
                {t('tour.title')}
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                {t('tour.subtitle')}
              </p>
            </Reveal>

            <Reveal>
              <ProductTour
                tabs={TOUR_TABS.map(({ key, src }) => ({
                  key,
                  src,
                  title: t(`tour.tabs.${key}.title`),
                  desc: t(`tour.tabs.${key}.desc`),
                  path: t(`tour.path.${key}`),
                  alt: t(`tour.shots.${key}`),
                }))}
              />
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Testimonials marquee                                             */}
        {/* ---------------------------------------------------------------- */}
        <TestimonialsMarquee />

        {/* ---------------------------------------------------------------- */}
        {/* Pricing                                                          */}
        {/* ---------------------------------------------------------------- */}
        <PricingSection />

        {/* ---------------------------------------------------------------- */}
        {/* FAQ                                                              */}
        {/* ---------------------------------------------------------------- */}
        <FaqSection />

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
              <h2 className="relative mt-6 font-display text-3xl font-semibold tracking-tight text-white md:text-4xl">
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
