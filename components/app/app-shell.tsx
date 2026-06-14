'use client';

import * as React from 'react';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import { cn } from '@/lib/utils';

/**
 * App chrome: persistent sidebar rail at `lg+`, a slide-in drawer below `lg`
 * (opened by the top-bar hamburger), and the scrollable main column. Holds the
 * drawer's open state so the top bar and drawer stay in sync.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const lastFocused = React.useRef<HTMLElement | null>(null);

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
    <div className="flex min-h-screen bg-background">
      <Sidebar className="hidden lg:flex" />

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
          tabIndex={-1}
          className={cn(
            'absolute inset-y-0 left-0 w-64 max-w-[85%] shadow-xl outline-none transition-transform duration-200',
            open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar className="h-full" onNavigate={() => setOpen(false)} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenuClick={() => setOpen(true)} />
        <main className="flex-1 p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
