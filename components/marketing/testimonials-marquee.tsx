import { getTranslations } from 'next-intl/server';
import { Star } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Marquee } from '@/components/marketing/ui/marquee';
import { Reveal } from '@/components/marketing/reveal';

const QUOTES = ['a', 'b', 'c'] as const;

/** Initials avatar — no real photos exist, so we derive initials from the name. */
function initials(name: string) {
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Template's infinite testimonial marquee. The three quotes are rendered
 * twice per group (and the Marquee doubles the group again) so the CSS
 * -50% loop never shows a gap on wide viewports.
 */
export async function TestimonialsMarquee() {
  const t = await getTranslations('marketing.testimonials');

  return (
    <section className="border-y border-border bg-surface/40 py-20 md:py-28">
      <Reveal className="mx-auto max-w-2xl px-4 text-center sm:px-6">
        <h2 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          {t('title')}
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">{t('subtitle')}</p>
      </Reveal>

      <Reveal delay={120} className="mt-14">
        <Marquee>
          {[...QUOTES, ...QUOTES].map((which, i) => (
            <TestimonialCard
              key={`${which}-${i}`}
              quote={t(`${which}.quote`)}
              name={t(`${which}.name`)}
              role={t(`${which}.role`)}
            />
          ))}
        </Marquee>
      </Reveal>
    </section>
  );
}

function TestimonialCard({
  quote,
  name,
  role,
}: {
  quote: string;
  name: string;
  role: string;
}) {
  return (
    <Card className="flex w-80 flex-col gap-4 p-7 shadow-md md:w-96 md:p-8">
      <div className="flex items-center gap-1" aria-hidden>
        {Array.from({ length: 5 }).map((_, i) => (
          <Star key={i} className="size-4 fill-accent-500 text-accent-500" />
        ))}
      </div>
      <blockquote className="text-sm leading-relaxed text-foreground md:text-base">
        “{quote}”
      </blockquote>
      <figcaption className="mt-auto flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-700 font-display text-xs font-semibold text-white">
          {initials(name)}
        </span>
        <span>
          <span className="block font-display text-sm font-semibold text-foreground">
            {name}
          </span>
          <span className="block text-xs text-muted-foreground">{role}</span>
        </span>
      </figcaption>
    </Card>
  );
}
