'use client';

import * as React from 'react';
import { Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Demo video for the hero. Ported from the purchased template's
 * `HeroVideoDialog`, but rebuilt with pure CSS transitions instead of
 * `motion/react` (the project ships no animation library and the marketing
 * surface deliberately avoids one — see `Reveal`).
 *
 * The poster behind the play button is passed in as `children` (the live
 * `AppPreview` server component), so the placeholder literally shows the
 * product. When the walkthrough is recorded, set `DEMO_VIDEO_URL` to the embed
 * URL below — the modal then plays it and the "coming soon" state disappears.
 * Nothing else needs to change.
 */
const DEMO_VIDEO_URL = '';

interface HeroVideoProps {
  /** Poster rendered behind the play overlay (the live AppPreview). */
  children: React.ReactNode;
  className?: string;
  labels: {
    playVideo: string;
    comingSoon: string;
    comingSoonHint: string;
  };
}

export function HeroVideo({ children, className, labels }: HeroVideoProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  // Drives the enter transition: false on mount, flipped true on next frame.
  const [entered, setEntered] = React.useState(false);

  React.useEffect(() => {
    if (!isOpen) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', onKey);

    // Lock background scroll while the modal is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        aria-label={labels.playVideo}
        onClick={() => setIsOpen(true)}
        className="group relative block w-full cursor-pointer rounded-2xl border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
      >
        {/* Poster (decorative — the button carries the label). On mobile it is
            cropped to a compact 16:9 thumbnail; from sm+ it shows the full
            preview. No hover/entrance animation. */}
        <div
          aria-hidden
          className="w-full overflow-hidden rounded-2xl max-sm:aspect-video"
        >
          {children}
        </div>

        {/* Bottom fade into the page background, like the template */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 rounded-b-2xl bg-gradient-to-t from-background to-transparent" />

        {/* Centered play button (static — no hover/scale animation) */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-accent-500/10 backdrop-blur-md sm:size-24">
            <div className="relative flex size-12 items-center justify-center rounded-full bg-gradient-to-b from-accent-500 to-accent-700 shadow-lg sm:size-16">
              <Play
                className="size-5 fill-white text-white sm:size-7"
                style={{
                  filter:
                    'drop-shadow(0 4px 3px rgb(0 0 0 / 0.07)) drop-shadow(0 2px 2px rgb(0 0 0 / 0.06))',
                }}
              />
            </div>
          </div>
        </div>
      </button>

      {isOpen && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Close video"
          onClick={() => setIsOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setIsOpen(false);
          }}
          className={cn(
            'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-md transition-opacity duration-200',
            entered ? 'opacity-100' : 'opacity-0',
          )}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'relative mx-auto w-full max-w-4xl transition-all duration-300 ease-out',
              entered ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
            )}
          >
            <button
              type="button"
              aria-label="Close video"
              onClick={() => setIsOpen(false)}
              className="absolute -top-12 right-0 flex size-9 items-center justify-center rounded-full bg-white/10 text-white ring-1 ring-white/20 backdrop-blur-md transition-colors hover:bg-white/20"
            >
              <X className="size-5" />
            </button>

            <div className="relative isolate aspect-video w-full overflow-hidden rounded-2xl border-2 border-white/80 shadow-2xl">
              {DEMO_VIDEO_URL ? (
                <iframe
                  src={DEMO_VIDEO_URL}
                  title={labels.playVideo}
                  className="size-full"
                  allowFullScreen
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-accent-600 to-accent-800 px-6 text-center">
                  <div className="flex size-14 items-center justify-center rounded-full bg-white/15 backdrop-blur-md">
                    <Play className="size-6 fill-white text-white" />
                  </div>
                  <p className="font-display text-xl font-semibold text-white sm:text-2xl">
                    {labels.comingSoon}
                  </p>
                  <p className="max-w-md text-sm text-white/80">
                    {labels.comingSoonHint}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
