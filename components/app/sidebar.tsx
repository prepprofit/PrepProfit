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
  LineChart,
  Receipt,
  Calculator,
  Users,
  FileText,
  Truck,
  Settings,
  CreditCard,
  Upload,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
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
  financials: LineChart,
  transactions: Receipt,
  breakEven: Calculator,
  payroll: Users,
  invoices: FileText,
  suppliers: Truck,
};

/**
 * Shared link styling for nav rows (modules + the bottom Settings/Trash). Active
 * rows become a solid accent pill (white text/icon); idle rows pick up an accent
 * tint on hover. When collapsed the row is icon-only and centred.
 */
function navRowClass(active: boolean, collapsed: boolean) {
  return cn(
    'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    collapsed && 'justify-center px-0',
    active
      ? 'bg-accent-600 text-white shadow-sm shadow-accent-600/30'
      : 'text-muted-foreground hover:bg-accent-50 hover:text-accent-700 dark:hover:bg-accent-500/10 dark:hover:text-accent-300',
  );
}

export function Sidebar({
  className,
  onNavigate,
  canSeeFinance = true,
  collapsed = false,
  onToggleCollapse,
}: {
  className?: string;
  onNavigate?: () => void;
  /**
   * Manager-only gate. Kitchen-role users don't see the Finance group, the Team
   * group (Payroll), Trash or Settings (cosmetic; server enforces each route).
   */
  canSeeFinance?: boolean;
  /** Icon-only rail (desktop). The mobile drawer always renders expanded. */
  collapsed?: boolean;
  /** Provided only for the desktop rail; renders the collapse toggle when set. */
  onToggleCollapse?: () => void;
}) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const tGroups = useTranslations('navGroups');
  const tApp = useTranslations('app');
  const tTop = useTranslations('topbar');
  const { resolvedTheme } = useTheme();

  // Kitchen staff lose the Finance + Team groups entirely, and the Dashboard
  // (a manager cockpit — the server redirects them away from it) is dropped from
  // the Operations group too.
  const groups = canSeeFinance
    ? navGroups
    : navGroups
        .filter((group) => group.key !== 'finance' && group.key !== 'team')
        .map((group) =>
          group.key === 'operations'
            ? {
                ...group,
                items: group.items.filter((item) => item.key !== 'dashboard'),
              }
            : group,
        );

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  // The bottom section holds manager-only links (Trash/Settings) and the org
  // switcher (expanded only). Skip it entirely when it would be empty — a
  // kitchen user on the collapsed rail — so no stray divider line shows.
  const showFooter = canSeeFinance || !collapsed;

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-64',
        className,
      )}
    >
      <div
        className={cn(
          'flex items-center py-5',
          collapsed ? 'justify-center px-2' : 'px-6',
        )}
      >
        {!collapsed && (
          <>
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
          </>
        )}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? tTop('expandSidebar') : tTop('collapseSidebar')}
            className={cn(
              'inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              !collapsed && 'ml-auto',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-2">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-1">
            {collapsed ? (
              <div className="mx-3 mb-1 border-t border-border" aria-hidden />
            ) : (
              <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {tGroups(group.key)}
              </p>
            )}
            {group.items.map(({ key, href }) => {
              const Icon = icons[key];
              const active = isActive(href);
              return (
                <Link
                  key={key}
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? t(key) : undefined}
                  className={navRowClass(active, collapsed)}
                >
                  <Icon
                    className={cn(
                      'size-4 shrink-0',
                      active
                        ? 'text-white'
                        : 'text-muted-foreground group-hover:text-accent-700 dark:group-hover:text-accent-300',
                    )}
                  />
                  {!collapsed && t(key)}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {showFooter && (
        <div className="flex flex-col gap-2 border-t border-border p-3">
          {/* Trash is manager-only (financial records + destructive purges); the
              server enforces it on the page + every action, this just hides it. */}
          {canSeeFinance && (
            <Link
              href="/trash"
              onClick={onNavigate}
              aria-current={isActive('/trash') ? 'page' : undefined}
              title={collapsed ? t('trash') : undefined}
              className={navRowClass(isActive('/trash'), collapsed)}
            >
              <Trash2 className="size-4 shrink-0" />
              {!collapsed && t('trash')}
            </Link>
          )}
          {/* Plans & billing — subscription/entitlements (Sprint 4). Manager-only;
              the page + Clerk checkout require org-admin too. */}
          {canSeeFinance && (
            <Link
              href="/billing"
              onClick={onNavigate}
              aria-current={isActive('/billing') ? 'page' : undefined}
              title={collapsed ? t('billing') : undefined}
              className={navRowClass(isActive('/billing'), collapsed)}
            >
              <CreditCard className="size-4 shrink-0" />
              {!collapsed && t('billing')}
            </Link>
          )}
          {/* Deterministic import (Sprint 4.5) — creates ingredients/transactions
              from a file; manager-only, the server enforces the page + actions. */}
          {canSeeFinance && (
            <Link
              href="/import"
              onClick={onNavigate}
              aria-current={isActive('/import') ? 'page' : undefined}
              title={collapsed ? t('import') : undefined}
              className={navRowClass(isActive('/import'), collapsed)}
            >
              <Upload className="size-4 shrink-0" />
              {!collapsed && t('import')}
            </Link>
          )}
          {/* Settings edits org-wide config (currency, measurement system) — a
              manager concern; the server must enforce it too (see settings page). */}
          {canSeeFinance && (
            <Link
              href="/settings"
              onClick={onNavigate}
              aria-current={isActive('/settings') ? 'page' : undefined}
              title={collapsed ? t('settings') : undefined}
              className={navRowClass(isActive('/settings'), collapsed)}
            >
              <Settings className="size-4 shrink-0" />
              {!collapsed && t('settings')}
            </Link>
          )}
          {!collapsed && (
            <OrganizationSwitcher
              hidePersonal
              afterCreateOrganizationUrl="/dashboard"
              afterSelectOrganizationUrl="/dashboard"
              appearance={clerkAppearance(resolvedTheme === 'dark')}
            />
          )}
        </div>
      )}
    </aside>
  );
}
