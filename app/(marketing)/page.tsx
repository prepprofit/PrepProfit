import Link from 'next/link';
import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/app/theme-toggle';

export default async function MarketingPage() {
  const t = await getTranslations('marketing');
  const tApp = await getTranslations('app');

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
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

      <main className="mx-auto flex max-w-3xl flex-1 flex-col items-center justify-center px-6 text-center">
        <Badge variant="accent">{t('eyebrow')}</Badge>
        <h1 className="mt-5 font-display text-4xl font-bold tracking-tight text-foreground md:text-5xl">
          {t('headline')}
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          {t('subhead')}
        </p>
        <div className="mt-10">
          <Button asChild size="lg">
            <Link href="/sign-up">{t('ctaPrimary')}</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
