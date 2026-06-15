'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { UserButton } from '@clerk/nextjs';
import { Bell, Menu } from 'lucide-react';
import { navItems } from '@/lib/nav';
import { clerkAppearance } from '@/lib/clerk-appearance';
import { ThemeToggle } from './theme-toggle';

const iconButton =
  'inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const tTop = useTranslations('topbar');
  const { resolvedTheme } = useTheme();

  const current = navItems.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );

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
        {current ? t(current.key) : ''}
      </h1>

      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <button type="button" aria-label={tTop('notifications')} className={`relative ${iconButton}`}>
          <Bell className="size-4" />
          <span
            className="absolute right-2 top-2 size-1.5 rounded-full bg-accent-500"
            aria-hidden
          />
        </button>
        <UserButton appearance={clerkAppearance(resolvedTheme === 'dark')} />
      </div>
    </header>
  );
}
