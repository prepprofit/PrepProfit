'use client';

import * as React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Menu, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/app/theme-toggle';
import { cn } from '@/lib/utils';

const NAV_LINKS = [
  { href: '#features', key: 'features' },
  { href: '#how-it-works', key: 'howItWorks' },
  { href: '#pricing', key: 'pricing' },
  { href: '#faq', key: 'faq' },
] as const;

export function MarketingHeader({ productName }: { productName: string }) {
  const t = useTranslations('marketing.nav');
  const [scrolled, setScrolled] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        'sticky top-0 z-30 transition-colors duration-300',
        scrolled
          ? 'border-b border-border/80 bg-background/80 backdrop-blur-xl'
          : 'border-b border-transparent',
      )}
    >
      {/* Three-zone bar: nav left · logo center · actions right (template layout). */}
      <div className="mx-auto grid h-16 max-w-7xl grid-cols-[auto_1fr_auto] items-center gap-4 px-4 sm:px-6 lg:grid-cols-3 lg:px-8">
        {/* Left — primary nav (desktop) */}
        <nav className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.key}
              href={link.href}
              className="rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {t(link.key)}
            </a>
          ))}
        </nav>

        {/* Center — logo */}
        <Link
          href="/"
          className="flex items-center lg:justify-center"
          aria-label={productName}
        >
          <Image
            src="/logo.webp"
            alt={productName}
            width={512}
            height={112}
            priority
            className="h-8 w-auto dark:hidden"
          />
          <Image
            src="/logo-white.webp"
            alt={productName}
            width={512}
            height={113}
            priority
            className="hidden h-8 w-auto dark:block"
          />
        </Link>

        {/* Right — actions */}
        <div className="flex items-center justify-end gap-2">
          <ThemeToggle />
          <Button asChild variant="ghost" className="hidden sm:inline-flex">
            <Link href="/sign-in">{t('signIn')}</Link>
          </Button>
          <Button asChild className="hidden sm:inline-flex">
            <Link href="/sign-up">{t('getStarted')}</Link>
          </Button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? t('closeMenu') : t('openMenu')}
            aria-expanded={open}
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="border-t border-border bg-background/95 backdrop-blur-xl lg:hidden">
          <nav className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-4 sm:px-6">
            {NAV_LINKS.map((link) => (
              <a
                key={link.key}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-base font-medium text-foreground transition-colors hover:bg-surface-2"
              >
                {t(link.key)}
              </a>
            ))}
            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-4">
              <Button asChild variant="outline" onClick={() => setOpen(false)}>
                <Link href="/sign-in">{t('signIn')}</Link>
              </Button>
              <Button asChild onClick={() => setOpen(false)}>
                <Link href="/sign-up">{t('getStarted')}</Link>
              </Button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
