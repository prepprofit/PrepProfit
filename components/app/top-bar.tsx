'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import * as React from 'react';
import { UserButton } from '@clerk/nextjs';
import { Bell, Menu, Search, Settings, CreditCard } from 'lucide-react';
import { navItems } from '@/lib/nav';
import { clerkAppearance } from '@/lib/clerk-appearance';
import { ThemeToggle } from './theme-toggle';

const iconButton =
  'inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function TopBar({
  onMenuClick,
  onSearchClick,
  canSeeFinance = true,
}: {
  onMenuClick: () => void;
  onSearchClick: () => void;
  /**
   * Manager-only gate. The account/admin links (Settings, Billing, Import,
   * Trash) live in the user-button menu; each route is still server-enforced.
   */
  canSeeFinance?: boolean;
}) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const tTop = useTranslations('topbar');
  const tSearch = useTranslations('search');
  const { resolvedTheme } = useTheme();

  // Resolve the shortcut hint after mount to avoid an SSR/CSR mismatch and to
  // show the right modifier per OS (⌘ on macOS, Ctrl elsewhere).
  const [shortcut, setShortcut] = React.useState<string | null>(null);
  React.useEffect(() => {
    const isMac = /mac|iphone|ipad/i.test(navigator.userAgent);
    setShortcut(isMac ? '⌘K' : 'Ctrl K');
  }, []);

  const current = navItems.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );

  // System pages live outside navItems (sidebar bottom) but still need a title.
  const systemKey = pathname.startsWith('/trash')
    ? 'trash'
    : pathname.startsWith('/settings')
      ? 'settings'
      : pathname.startsWith('/billing') || pathname.startsWith('/pricing')
        ? 'billing'
        : pathname.startsWith('/onboarding')
          ? 'onboarding'
          : null;
  const titleKey = current?.key ?? systemKey;

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur-md md:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label={tTop('openMenu')}
        className={`${iconButton} lg:hidden`}
      >
        <Menu className="size-4" />
      </button>

      <h1 className="truncate font-display text-lg font-semibold text-foreground sm:text-2xl">
        {titleKey ? t(titleKey) : ''}
      </h1>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onSearchClick}
          aria-label={tSearch('open')}
          className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-border bg-surface px-3 text-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Search className="size-4" />
          <span className="hidden sm:inline">{tSearch('open')}</span>
          {shortcut && (
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground sm:inline">
              {shortcut}
            </kbd>
          )}
        </button>
        <ThemeToggle />
        <button type="button" aria-label={tTop('notifications')} className={`relative ${iconButton}`}>
          <Bell className="size-4" />
          <span
            className="absolute right-2 top-2 size-1.5 rounded-full bg-accent-500"
            aria-hidden
          />
        </button>
        <UserButton appearance={clerkAppearance(resolvedTheme === 'dark')}>
          {/* Account/admin links relocated from the sidebar footer — manager-only
              (each route is still enforced server-side). */}
          {canSeeFinance && (
            <UserButton.MenuItems>
              <UserButton.Link
                label={t('settings')}
                labelIcon={<Settings className="size-4" />}
                href="/settings"
              />
              <UserButton.Link
                label={t('billing')}
                labelIcon={<CreditCard className="size-4" />}
                href="/billing"
              />
            </UserButton.MenuItems>
          )}
        </UserButton>
      </div>
    </header>
  );
}
