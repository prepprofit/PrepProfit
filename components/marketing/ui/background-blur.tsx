import { cn } from '@/lib/utils';

/**
 * Hero backdrop — the exact soft blue watercolor blur that ships with the
 * purchased template (`background-blur-*.png`). Anchored to the top and faded
 * into transparency below, so it washes the top of the hero and clears before
 * the product preview, matching the template 1:1. Mobile uses a lighter asset.
 */
export function BackgroundBlur({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 -z-10 h-[820px] bg-[url('/background-blur-mobile.png')] bg-cover bg-top bg-no-repeat md:bg-[url('/background-blur-desktop.png')]",
        className,
      )}
    />
  );
}
