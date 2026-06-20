import Link from 'next/link';
import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Calculator, LineChart, ReceiptText, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ThemeToggle } from '@/components/app/theme-toggle';

export default async function MarketingPage() {
  const t = await getTranslations('marketing');
  const tApp = await getTranslations('app');

  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden">
      {/* Decorative accent glow behind the hero (reference look). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px]"
        style={{
          background:
            'radial-gradient(60% 60% at 50% 0%, color-mix(in oklab, var(--color-accent-500) 16%, transparent), transparent)',
        }}
      />

      <header className="flex items-center justify-between px-6 py-5 md:px-10">
        <div className="flex items-center">
          <Image
            src="/logo.webp"
            alt={tApp('name')}
            width={512}
            height={112}
            priority
            className="h-8 w-auto dark:hidden"
          />
          <Image
            src="/logo-white.webp"
            alt={tApp('name')}
            width={512}
            height={113}
            priority
            className="hidden h-8 w-auto dark:block"
          />
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button asChild variant="ghost">
            <Link href="/sign-in">{t('ctaSecondary')}</Link>
          </Button>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto flex max-w-3xl flex-col items-center px-6 pt-12 pb-20 text-center md:pt-20">
          <Badge variant="accent">{t('eyebrow')}</Badge>
          <h1 className="mt-5 font-display text-4xl font-bold tracking-tight text-foreground md:text-5xl">
            {t('headline')}
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground">
            {t('subhead')}
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/sign-up">{t('ctaPrimary')}</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/sign-in">{t('ctaSecondary')}</Link>
            </Button>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto max-w-5xl px-6 pb-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
              {t('features.title')}
            </h2>
            <p className="mt-3 text-muted-foreground">{t('features.subtitle')}</p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {(
              [
                { key: 'costing', Icon: Calculator },
                { key: 'financials', Icon: LineChart },
                { key: 'operations', Icon: ReceiptText },
                { key: 'ai', Icon: Sparkles },
              ] as const
            ).map(({ key, Icon }) => (
              <Card key={key}>
                <CardHeader>
                  <div
                    className="mb-1 flex size-9 items-center justify-center rounded-full bg-accent-500/12 text-accent-600"
                    aria-hidden
                  >
                    <Icon className="size-4" />
                  </div>
                  <CardTitle>{t(`features.${key}.title`)}</CardTitle>
                  <CardDescription>{t(`features.${key}.body`)}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        {/* CTA band */}
        <section className="mx-auto max-w-5xl px-6 pb-20">
          <Card className="flex flex-col items-center gap-5 px-6 py-12 text-center">
            <CardContent className="flex flex-col items-center gap-5 p-0">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
                {t('ctaBand.title')}
              </h2>
              <p className="max-w-md text-muted-foreground">
                {t('ctaBand.subtitle')}
              </p>
              <Button asChild size="lg">
                <Link href="/sign-up">{t('ctaBand.action')}</Link>
              </Button>
            </CardContent>
          </Card>
        </section>
      </main>

      <footer className="border-t border-border px-6 py-8 md:px-10">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 text-sm text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} {tApp('name')}</span>
          <span>{t('footerNote')}</span>
        </div>
      </footer>
    </div>
  );
}
