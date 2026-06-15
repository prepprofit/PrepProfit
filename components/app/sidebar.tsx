'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { OrganizationSwitcher } from '@clerk/nextjs';
import {
  LayoutDashboard,
  Utensils,
  Package,
  Boxes,
  Calculator,
  Users,
  FileText,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { navGroups, type NavKey } from '@/lib/nav';
import { clerkAppearance } from '@/lib/clerk-appearance';
import { cn } from '@/lib/utils';

const icons: Record<NavKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  recipes: Utensils,
  ingredients: Package,
  inventory: Boxes,
  breakEven: Calculator,
  payroll: Users,
  invoices: FileText,
};

export function Sidebar({
  className,
  onNavigate,
}: {
  className?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const tGroups = useTranslations('navGroups');
  const tApp = useTranslations('app');
  const { resolvedTheme } = useTheme();

  return (
    <aside
      className={cn(
        'flex w-64 shrink-0 flex-col border-r border-border bg-surface',
        className,
      )}
    >
      <div className="flex items-center px-6 py-5">
        <Image
          src="/logo.webp"
          alt={tApp('name')}
          width={512}
          height={112}
          priority
          className="h-7 w-auto dark:hidden"
        />
        <Image
          src="/logo-white.webp"
          alt={tApp('name')}
          width={512}
          height={113}
          priority
          className="hidden h-7 w-auto dark:block"
        />
      </div>

      <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-2">
        {navGroups.map((group) => (
          <div key={group.key} className="flex flex-col gap-1">
            <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {tGroups(group.key)}
            </p>
            {group.items.map(({ key, href }) => {
              const Icon = icons[key];
              const active =
                pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={key}
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-surface-2 text-accent-700 dark:text-accent-400'
                      : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                  )}
                >
                  {active && (
                    <span
                      className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent-500"
                      aria-hidden
                    />
                  )}
                  <Icon
                    className={cn(
                      'size-4 shrink-0',
                      active
                        ? 'text-accent-500'
                        : 'text-muted-foreground group-hover:text-foreground',
                    )}
                  />
                  {t(key)}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex flex-col gap-2 border-t border-border p-3">
        <Link
          href="/settings"
          onClick={onNavigate}
          aria-current={
            pathname === '/settings' || pathname.startsWith('/settings/')
              ? 'page'
              : undefined
          }
          className={cn(
            'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            pathname === '/settings' || pathname.startsWith('/settings/')
              ? 'bg-surface-2 text-accent-700 dark:text-accent-400'
              : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
          )}
        >
          <Settings className="size-4 shrink-0" />
          {t('settings')}
        </Link>
        <OrganizationSwitcher
          hidePersonal
          afterCreateOrganizationUrl="/dashboard"
          afterSelectOrganizationUrl="/dashboard"
          appearance={clerkAppearance(resolvedTheme === 'dark')}
        />
      </div>
    </aside>
  );
}
