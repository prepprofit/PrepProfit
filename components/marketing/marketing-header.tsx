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

/**
 * Template's floating nav: fixed bar that shrinks into a blurred rounded
 * pill once the page scrolls, logo left, absolutely-centered links, actions
 * right (collapsing to a single CTA in the pill state), and a card-style
 * mobile menu behind an animated hamburger.
 */
export function MarketingHeader({ productName }: { productName: string }) {
  const t = useTranslations('marketing.nav');
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleNavClick = (
    e: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    e.preventDefault();
    setMenuOpen(false);
    const el = document.getElementById(href.replace('#', ''));
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    } else {
      // Not on the landing page (e.g. /terms, /privacy): go there first.
      window.location.href = `/${href}`;
    }
  };

  return (
    <header>
      <nav
        data-state={menuOpen ? 'active' : undefined}
        className="fixed left-1/2 top-0 z-30 w-full -translate-x-1/2 px-2"
      >
        <div
          className={cn(
            'mx-auto mt-2 max-w-6xl border border-transparent bg-transparent px-6 transition-all duration-300 ease-out lg:px-12',
            scrolled &&
              'max-w-4xl rounded-3xl border-border bg-background/60 backdrop-blur-2xl lg:px-5',
          )}
        >
          <div className="relative flex flex-wrap items-center justify-between gap-6 py-3 lg:gap-0 lg:py-4">
            {/* Left — logo (+ mobile hamburger) */}
            <div className="flex w-full justify-between lg:w-auto">
              <Link
                href="/"
                aria-label={productName}
                className="flex items-center space-x-2"
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

              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label={menuOpen ? t('closeMenu') : t('openMenu')}
                aria-expanded={menuOpen}
                className="relative z-20 -m-2.5 -mr-4 block cursor-pointer p-2.5 lg:hidden"
              >
                <Menu className="m-auto size-6 duration-200 in-data-[state=active]:rotate-180 in-data-[state=active]:scale-0 in-data-[state=active]:opacity-0" />
                <X className="absolute inset-0 m-auto size-6 -rotate-180 scale-0 opacity-0 duration-200 in-data-[state=active]:rotate-0 in-data-[state=active]:scale-100 in-data-[state=active]:opacity-100" />
              </button>
            </div>

            {/* Center — absolutely centered links (desktop) */}
            <div className="absolute inset-0 m-auto hidden size-fit lg:block">
              <ul className="flex gap-8 text-sm">
                {NAV_LINKS.map((link) => (
                  <li key={link.key}>
                    <a
                      href={link.href}
                      onClick={(e) => handleNavClick(e, link.href)}
                      className="block text-muted-foreground duration-150 hover:text-foreground"
                    >
                      {t(link.key)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            {/* Right — actions; doubles as the mobile menu card */}
            <div className="mb-6 hidden w-full space-y-8 rounded-3xl border border-border bg-background p-6 shadow-2xl shadow-black/5 in-data-[state=active]:block lg:m-0 lg:flex lg:w-fit lg:items-center lg:justify-end lg:gap-6 lg:space-y-0 lg:border-transparent lg:bg-transparent lg:p-0 lg:shadow-none dark:shadow-none">
              {/* Mobile menu links */}
              <div className="lg:hidden">
                <ul className="space-y-6 text-base">
                  {NAV_LINKS.map((link) => (
                    <li key={link.key}>
                      <a
                        href={link.href}
                        onClick={(e) => handleNavClick(e, link.href)}
                        className="block text-muted-foreground duration-150 hover:text-foreground"
                      >
                        {t(link.key)}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Buttons */}
              <div className="flex w-full flex-col space-y-3 sm:flex-row sm:items-center sm:gap-3 sm:space-y-0 md:w-fit">
                <ThemeToggle />

                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className={cn(scrolled && 'lg:hidden')}
                  onClick={() => setMenuOpen(false)}
                >
                  <Link href="/sign-in">{t('signIn')}</Link>
                </Button>

                <Button
                  asChild
                  size="sm"
                  onClick={() => setMenuOpen(false)}
                >
                  <Link href="/sign-up">{t('getStarted')}</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </nav>
    </header>
  );
}
