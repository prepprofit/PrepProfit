'use client';

import * as React from 'react';
import Image from 'next/image';
import { cn } from '@/lib/utils';

export interface TourTab {
  key: string;
  /** Short tab title (bold). */
  title: string;
  /** One-line description under the title. */
  desc: string;
  /** Fake browser path shown in the mockup chrome. */
  path: string;
  /** Screenshot path under /public (e.g. /screenshots/dashboard.webp). */
  src: string;
  /** Accessible description of the screenshot. */
  alt: string;
}

/**
 * Folio-style product tour: a row of card-style tabs (title + short
 * description) that switch a screen mockup below. Each panel frames a real
 * product screenshot inside a browser-window chrome, so the section sells the
 * app with its own UI instead of decorative filler.
 *
 * Client component (tab state only). Copy is resolved server-side and passed
 * in via `tabs`, matching the marketing surface's props pattern.
 */
export function ProductTour({ tabs }: { tabs: TourTab[] }) {
  const [active, setActive] = React.useState(0);
  const panelId = 'product-tour-panel';
  const current = tabs[active] ?? tabs[0];

  if (!current) return null;

  return (
    <div className="mt-12">
      {/* Tab bar — card-style triggers, active gets an accent underline */}
      <div
        role="tablist"
        aria-label="Product tour"
        className="grid grid-cols-2 gap-2 border-b border-border sm:gap-3 md:grid-cols-4"
      >
        {tabs.map((tab, i) => {
          const selected = i === active;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`tour-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={panelId}
              onClick={() => setActive(i)}
              className={cn(
                'group relative -mb-px flex flex-col items-start rounded-t-xl border-b-2 px-3 py-3 text-left transition-colors duration-200 sm:px-4 sm:py-4',
                selected
                  ? 'border-accent-600 bg-surface'
                  : 'border-transparent hover:bg-surface/60',
              )}
            >
              <span
                className={cn(
                  'font-display text-sm font-semibold tracking-tight transition-colors sm:text-base',
                  selected
                    ? 'text-foreground'
                    : 'text-muted-foreground group-hover:text-foreground',
                )}
              >
                {tab.title}
              </span>
              <span className="mt-0.5 text-xs leading-snug text-muted-foreground sm:text-[13px]">
                {tab.desc}
              </span>
            </button>
          );
        })}
      </div>

      {/* Screen mockup — browser chrome framing the active screenshot */}
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`tour-tab-${current.key}`}
        className="mt-6 overflow-hidden rounded-2xl border border-border bg-surface shadow-xl shadow-black/5"
      >
        {/* Window chrome */}
        <div className="flex items-center gap-2 border-b border-border bg-surface-2/50 px-4 py-2.5">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-red-400/70" />
            <span className="size-2.5 rounded-full bg-amber-400/70" />
            <span className="size-2.5 rounded-full bg-emerald-400/70" />
          </span>
          <span className="mx-auto hidden max-w-xs flex-1 truncate rounded-md bg-background/70 px-3 py-1 text-center text-xs text-muted-foreground sm:block">
            {current.path}
          </span>
        </div>

        {/* Screenshot — 16:10 frame; the real capture drops into /public */}
        <div className="relative aspect-[16/10] w-full bg-surface-2/30">
          {tabs.map((tab, i) => (
            <Image
              key={tab.key}
              src={tab.src}
              alt={tab.alt}
              fill
              sizes="(min-width: 1024px) 960px, 100vw"
              priority={i === 0}
              className={cn(
                'object-cover object-top transition-opacity duration-300',
                i === active ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
