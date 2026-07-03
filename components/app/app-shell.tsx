'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import { CommandPalette } from './command-palette';
import { TrialTopBanner } from './trial/trial-top-banner';
import type { TrialView } from '@/lib/trial';
import type { SidebarAiMeterView } from '@/lib/data/ai-usage';
import { cn } from '@/lib/utils';

/**
 * App chrome: persistent sidebar rail at `lg+`, a slide-in drawer below `lg`
 * (opened by the top-bar hamburger), and the scrollable main column. Holds the
 * drawer's open state so the top bar and drawer stay in sync.
 */
export function AppShell({
  children,
  canSeeFinance,
  trial,
  sidebarAiMeter,
  lowestPaidPrice,
}: {
  children: React.ReactNode;
  /** Forwarded to both Sidebar instances; hides Finance for kitchen role. */
  canSeeFinance: boolean;
  /** Active reverse-trial view (manager-only); `null` disables the top banner. */
  trial: TrialView | null;
  /** Photo-extraction usage meter for the expanded sidebar footer (manager-only). */
  sidebarAiMeter: SidebarAiMeterView | null;
  /** Lowest paid price label for the banner copy (empty for kitchen). */
  lowestPaidPrice: string;
}) {
  const tTop = useTranslations('topbar');
  const [open, setOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const lastFocused = React.useRef<HTMLElement | null>(null);

  // Restore the desktop rail's collapsed preference (set after mount to avoid an
  // SSR/CSR mismatch — the server always renders the expanded rail).
  React.useEffect(() => {
    setCollapsed(localStorage.getItem('pp-sidebar-collapsed') === '1');
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem('pp-sidebar-collapsed', next ? '1' : '0');
      return next;
    });
  }, []);

  // ⌘K / Ctrl-K toggles the global search palette from anywhere in the app.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close on Escape while the drawer is open.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Lock body scroll + manage focus when the drawer opens/closes.
  React.useEffect(() => {
    if (open) {
      lastFocused.current = document.activeElement as HTMLElement | null;
      document.body.style.overflow = 'hidden';
      dialogRef.current?.focus();
    } else {
      document.body.style.overflow = '';
      lastFocused.current?.focus();
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Full-width trial strip above the chrome — spans the sidebar + top bar. */}
      <TrialTopBanner trial={trial} lowestPaidPrice={lowestPaidPrice} />

      <div className="flex min-h-0 flex-1 overflow-hidden">
      <Sidebar
        className="hidden lg:flex"
        canSeeFinance={canSeeFinance}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        sidebarAiMeter={sidebarAiMeter}
      />

      {/* Mobile drawer */}
      <div
        className={cn('fixed inset-0 z-40 lg:hidden', !open && 'pointer-events-none')}
      >
        <div
          onClick={() => setOpen(false)}
          className={cn(
            'absolute inset-0 bg-slate-950/50 transition-opacity duration-200',
            open ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={tTop('menuTitle')}
          tabIndex={-1}
          className={cn(
            'absolute inset-y-0 left-0 w-64 max-w-[85%] shadow-xl outline-none transition-transform duration-200',
            open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar
            className="h-full"
            onNavigate={() => setOpen(false)}
            canSeeFinance={canSeeFinance}
            sidebarAiMeter={sidebarAiMeter}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          onMenuClick={() => setOpen(true)}
          onSearchClick={() => setPaletteOpen(true)}
          canSeeFinance={canSeeFinance}
        />
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        canSeeFinance={canSeeFinance}
      />
      </div>
    </div>
  );
}
