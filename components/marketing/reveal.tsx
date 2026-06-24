'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Lightweight scroll-reveal wrapper for the marketing page. Uses
 * IntersectionObserver (no animation library, no new deps) and degrades to a
 * plain visible element when the user prefers reduced motion. The element is
 * always rendered in the DOM; only opacity/transform animate, so there is no
 * layout shift (CLS-safe).
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  /** Stagger delay in ms. */
  delay?: number;
  as?: 'div' | 'li' | 'section';
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const reduce = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (reduce) {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const Component = Tag as React.ElementType;

  return (
    <Component
      ref={ref}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
      className={cn(
        'transition-[opacity,transform] duration-700 ease-out motion-reduce:transition-none',
        shown ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0',
        className,
      )}
    >
      {children}
    </Component>
  );
}
