'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Full-screen prep slideshow (plan §9.4): one step per slide, arrow-key and
 * swipe navigation, `prefers-reduced-motion` disables the slide transition.
 * The payload is built from the KITCHEN DTO — money-free by construction.
 * Step text renders as TEXT, never HTML (plan §12).
 */
export type SlideshowSlide = {
  id: string;
  sectionTitle: string | null;
  instruction: string;
  media: { url: string; kind: 'image' | 'video' }[];
};

export function RecipeSlideshow({
  recipeId,
  recipeName,
  slides,
}: {
  recipeId: string;
  recipeName: string;
  slides: SlideshowSlide[];
}) {
  const t = useTranslations('recipes.workspace.slideshow');
  const [index, setIndex] = React.useState(0);
  const [reducedMotion, setReducedMotion] = React.useState(false);
  const touchStartX = React.useRef<number | null>(null);

  const count = slides.length;
  const clamp = React.useCallback(
    (next: number) => Math.max(0, Math.min(count - 1, next)),
    [count],
  );
  const go = React.useCallback(
    (delta: number) => setIndex((i) => clamp(i + delta)),
    [clamp],
  );

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(media.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const slide = slides[index];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      onTouchStart={(e) => {
        touchStartX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = touchStartX.current;
        touchStartX.current = null;
        const end = e.changedTouches[0]?.clientX;
        if (start === null || end === undefined) return;
        if (end - start > 48) go(-1);
        if (start - end > 48) go(1);
      }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{recipeName}</h1>
          {count > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('stepOf', { current: index + 1, total: count })}
            </p>
          ) : null}
        </div>
        <Button asChild variant="ghost" size="sm" aria-label={t('exit')}>
          <Link href={`/recipes/${recipeId}`}>
            <X /> {t('exit')}
          </Link>
        </Button>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
        {count === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div
            key={slide!.id}
            className={
              reducedMotion
                ? 'flex max-h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto'
                : 'flex max-h-full w-full max-w-3xl animate-overlay-in flex-col gap-6 overflow-y-auto'
            }
          >
            {slide!.sectionTitle ? (
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {slide!.sectionTitle}
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-2xl leading-relaxed">
              {slide!.instruction}
            </p>
            {slide!.media.length > 0 ? (
              <div className="flex flex-wrap gap-4">
                {slide!.media.map((m) =>
                  m.kind === 'video' ? (
                    <video
                      key={m.url}
                      src={m.url}
                      controls
                      preload="metadata"
                      className="max-h-80 rounded-xl border border-border"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- short signed URL from the private store; next/image cannot optimize it
                    <img
                      key={m.url}
                      src={m.url}
                      alt=""
                      className="max-h-80 rounded-xl border border-border object-contain"
                    />
                  ),
                )}
              </div>
            ) : null}
          </div>
        )}
      </main>

      {count > 0 ? (
        <footer className="flex items-center justify-between border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => go(-1)}
            disabled={index === 0}
          >
            <ArrowLeft /> {t('previous')}
          </Button>
          <div className="flex gap-1" aria-hidden>
            {slides.map((s, i) => (
              <span
                key={s.id}
                className={
                  i === index
                    ? 'size-1.5 rounded-full bg-foreground'
                    : 'size-1.5 rounded-full bg-border'
                }
              />
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => go(1)}
            disabled={index === count - 1}
          >
            {t('next')} <ArrowRight />
          </Button>
        </footer>
      ) : null}
    </div>
  );
}
