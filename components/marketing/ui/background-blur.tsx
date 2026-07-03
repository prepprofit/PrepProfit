import { cn } from '@/lib/utils';

/**
 * Decorative hero backdrop. The purchased template shipped this as large PNG
 * blurs; we recreate it as pure CSS radial gradients tinted with the accent
 * and brand palettes so it adapts to both themes and costs no bytes.
 */
export function BackgroundBlur({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px] overflow-hidden',
        className,
      )}
    >
      <div className="absolute -top-40 left-1/2 h-[480px] w-[720px] -translate-x-[70%] rounded-full bg-accent-500/15 blur-3xl dark:bg-accent-500/10" />
      <div className="absolute -top-24 left-1/2 h-[420px] w-[640px] -translate-x-[20%] rounded-full bg-brand-400/10 blur-3xl dark:bg-brand-500/10" />
      <div className="absolute top-40 left-1/2 h-[320px] w-[880px] -translate-x-1/2 rounded-full bg-accent-300/10 blur-3xl dark:bg-accent-700/10" />
    </div>
  );
}
