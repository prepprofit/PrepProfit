import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * CSS-only infinite marquee: the track renders its children twice, so the
 * -50% translate loop (see --animate-marquee in globals.css) is seamless.
 * The global prefers-reduced-motion rule freezes it automatically.
 */
export function Marquee({
  children,
  reverse = false,
  className,
}: {
  children: ReactNode;
  reverse?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('marquee-mask overflow-hidden', className)}>
      <div
        className={cn(
          'flex w-max animate-marquee hover:[animation-play-state:paused]',
          reverse && '[animation-direction:reverse]',
        )}
      >
        <MarqueeGroup>{children}</MarqueeGroup>
        <MarqueeGroup ariaHidden>{children}</MarqueeGroup>
      </div>
    </div>
  );
}

function MarqueeGroup({
  children,
  ariaHidden = false,
}: {
  children: ReactNode;
  ariaHidden?: boolean;
}) {
  return (
    <div aria-hidden={ariaHidden || undefined} className="flex gap-4 pr-4">
      {children}
    </div>
  );
}
