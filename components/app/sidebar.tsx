'use client';

import * as React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { OrganizationSwitcher } from '@clerk/nextjs';
import {
  LayoutDashboard,
  Utensils,
  Scale,
  BookOpen,
  CookingPot,
  Package,
  Boxes,
  ListChecks,
  LineChart,
  Sparkles,
  Grid2x2,
  FileBarChart2,
  Receipt,
  Calculator,
  Users,
  FileText,
  Truck,
  ClipboardList,
  ShoppingCart,
  Upload,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react';
import { navGroups, dashboardItem, type NavKey, type NavGroupKey } from '@/lib/nav';
import { clerkAppearance } from '@/lib/clerk-appearance';
import { SidebarAiMeter } from './trial/sidebar-ai-meter';
import type { SidebarAiMeterView } from '@/lib/data/ai-usage';
import { cn } from '@/lib/utils';

const icons: Record<NavKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  recipes: Utensils,
  kitchenScale: Scale,
  menus: BookOpen,
  productions: CookingPot,
  ingredients: Package,
  inventory: Boxes,
  tasks: ListChecks,
  financials: LineChart,
  insights: Sparkles,
  menuEngineering: Grid2x2,
  cfoReport: FileBarChart2,
  transactions: Receipt,
  sales: ShoppingCart,
  breakEven: Calculator,
  payroll: Users,
  invoices: FileText,
  suppliers: Truck,
  purchaseOrders: ClipboardList,
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
  sidebarAiMeter,
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
  /** Manager-only photo-extraction usage meter; shown expanded-only in the footer. */
  sidebarAiMeter?: SidebarAiMeterView | null;
}) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const tGroups = useTranslations('navGroups');
  const tApp = useTranslations('app');
  const tTop = useTranslations('topbar');
  const { resolvedTheme } = useTheme();

  // Kitchen staff lose the Finance + Team groups entirely. The Dashboard (a
  // manager cockpit — the server redirects them away from it) is a standalone
  // top-level row, rendered below only when finance is visible.
  const groups = canSeeFinance
    ? navGroups
    : navGroups.filter((group) => group.key !== 'finance' && group.key !== 'team');

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  const activeGroupKey =
    groups.find((group) => group.items.some((item) => isActive(item.href)))
      ?.key ?? null;

  // Collapsible groups (expanded rail only — the icon rail keeps every item
  // visible). `null` until hydrated so SSR + first CSR render match the server's
  // all-open output and avoid a mismatch; an effect then restores the stored
  // preference (or defaults to just the active group open).
  const [openGroups, setOpenGroups] = React.useState<Set<NavGroupKey> | null>(
    null,
  );

  React.useEffect(() => {
    const stored = localStorage.getItem('pp-sidebar-groups');
    if (stored) {
      try {
        setOpenGroups(new Set(JSON.parse(stored) as NavGroupKey[]));
        return;
      } catch {
        // Corrupt value — fall through to the active-group default.
      }
    }
    // No stored preference yet: open every group so a first-time user sees the
    // whole app up front (discovery beats tidiness). Collapsing is opt-in and
    // the choice is then persisted below.
    setOpenGroups(new Set(groups.map((group) => group.key as NavGroupKey)));
    // Run once on mount; navigation is handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opening the group that owns the freshly-navigated route keeps the active
  // link visible without disturbing the user's other manual toggles.
  const prevPathname = React.useRef(pathname);
  React.useEffect(() => {
    if (prevPathname.current === pathname) return;
    prevPathname.current = pathname;
    if (!activeGroupKey) return;
    setOpenGroups((prev) => {
      if (prev === null || prev.has(activeGroupKey)) return prev;
      const next = new Set(prev).add(activeGroupKey);
      localStorage.setItem('pp-sidebar-groups', JSON.stringify([...next]));
      return next;
    });
  }, [pathname, activeGroupKey]);

  const isGroupOpen = (key: NavGroupKey) =>
    openGroups === null || openGroups.has(key);

  const toggleGroup = (key: NavGroupKey) => {
    setOpenGroups((prev) => {
      const base =
        prev ?? new Set(groups.map((group) => group.key as NavGroupKey));
      const next = new Set(base);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem('pp-sidebar-groups', JSON.stringify([...next]));
      return next;
    });
  };

  // The bottom section holds manager-only links (Trash/Import) and the org
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
        {/* Dashboard — standalone top-level row (no group header), manager-only. */}
        {canSeeFinance && (
          <div className="flex flex-col gap-1">
            {(() => {
              const { key, href } = dashboardItem;
              const Icon = icons[key];
              const active = isActive(href);
              return (
                <Link
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
            })()}
          </div>
        )}
        {groups.map((group) => {
          // The icon rail keeps every item visible (divider only); the expanded
          // rail collapses non-open groups behind their header.
          const open = collapsed || isGroupOpen(group.key);
          return (
          <div key={group.key} className="flex flex-col gap-1">
            {collapsed ? (
              <div className="mx-3 mb-1 border-t border-border" aria-hidden />
            ) : (
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                aria-expanded={open}
                className="group/header flex items-center justify-between gap-2 rounded-md px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>{tGroups(group.key)}</span>
                <span className="flex items-center gap-1.5">
                  {/* When the group is collapsed, surface the item count so the
                      header reads as "there's content in here", not a dead row. */}
                  {!open && (
                    <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-surface-2 px-1 text-[10px] font-semibold leading-none tabular-nums text-muted-foreground group-hover/header:bg-surface">
                      {group.items.length}
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      'size-3.5 shrink-0 transition-transform',
                      !open && '-rotate-90',
                    )}
                    aria-hidden
                  />
                </span>
              </button>
            )}
            {open &&
            group.items.map(({ key, href }) => {
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
          );
        })}
      </nav>

      {showFooter && (
        <div className="flex flex-col gap-2 border-t border-border p-3">
          {/* Photo-extraction usage meter — manager-only, expanded rail only (the
              icon rail keeps its compact footer). Serializable view built server-side. */}
          {canSeeFinance && !collapsed && sidebarAiMeter && (
            <SidebarAiMeter view={sidebarAiMeter} onNavigate={onNavigate} />
          )}
          {/* Settings + Plans & billing live in the top-bar user menu; Trash and
              Import stay here. Trash is manager-only (financial records +
              destructive purges); the server enforces the page + every action. */}
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
