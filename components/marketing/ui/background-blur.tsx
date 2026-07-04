import { cn } from '@/lib/utils';

/**
 * Hero backdrop — reproduces the purchased template's soft watercolor wash at
 * the top of the hero, but tinted with PrepProfit's brand accent (orange)
 * instead of the template's blue. Pure CSS radial blobs: on-brand, theme-aware
 * (dark mode tones down), and zero image bytes. Anchored to the top and fading
 * to transparent so it clears before the product preview, like the template.
 */
export function BackgroundBlur({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 -z-10 h-[820px] overflow-hidden',
        className,
      )}
    >
      {/* Broad central wash across the top */}
      <div className="absolute -top-56 left-1/2 h-[640px] w-[1200px] -translate-x-1/2 rounded-[50%] bg-accent-500/25 blur-[130px] dark:bg-accent-500/15" />
      {/* Two offset lobes for the template's overlapping-circles feel */}
      <div className="absolute -top-32 left-1/2 h-[460px] w-[720px] -translate-x-[78%] rounded-full bg-accent-400/20 blur-[120px] dark:bg-accent-500/12" />
      <div className="absolute -top-28 left-1/2 h-[480px] w-[760px] -translate-x-[18%] rounded-full bg-accent-300/20 blur-[120px] dark:bg-accent-700/14" />
    </div>
  );
}
