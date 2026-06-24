import { getTranslations } from 'next-intl/server';
import { Quote, Star } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Reveal } from '@/components/marketing/reveal';
import { cn } from '@/lib/utils';

/** Initials avatar — no real photos exist, so we derive initials from the name. */
function initials(name: string) {
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Large single-quote testimonial with an initials avatar (mirrors the
 * template's featured testimonials). `which` selects from `marketing.testimonials`.
 */
export async function TestimonialFeature({
  which,
  tinted = false,
}: {
  which: 'a' | 'b' | 'c';
  tinted?: boolean;
}) {
  const t = await getTranslations('marketing.testimonials');
  const name = t(`${which}.name`);

  return (
    <section
      className={cn(
        'px-4 py-16 sm:px-6 md:py-24 lg:px-8',
        tinted && 'border-y border-border bg-surface/40',
      )}
    >
      <Reveal className="mx-auto max-w-3xl text-center">
        <Card variant="glass" className="p-8 shadow-xl sm:p-12">
          <Quote className="mx-auto size-8 text-accent-500/40" aria-hidden />
          <div className="mt-5 flex items-center justify-center gap-1" aria-hidden>
            {Array.from({ length: 5 }).map((_, i) => (
              <Star
                key={i}
                className="size-4 fill-accent-500 text-accent-500"
              />
            ))}
          </div>
          <blockquote className="mt-6 font-display text-xl font-medium leading-relaxed text-foreground sm:text-2xl">
            “{t(`${which}.quote`)}”
          </blockquote>
          <figcaption className="mt-8 flex items-center justify-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-full bg-accent-700 font-display text-sm font-semibold text-white">
              {initials(name)}
            </span>
            <span className="text-left">
              <span className="block font-display text-sm font-semibold text-foreground">
                {name}
              </span>
              <span className="block text-sm text-muted-foreground">
                {t(`${which}.role`)}
              </span>
            </span>
          </figcaption>
        </Card>
      </Reveal>
    </section>
  );
}
