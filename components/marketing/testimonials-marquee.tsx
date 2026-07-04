import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Reveal } from '@/components/marketing/reveal';

/**
 * Single profile-card testimonial: photo with an overlapping quote card.
 * ponytail: one testimonial for now (Gui's real review lands later), so no
 * carousel/state — turn this into a client carousel when a second quote exists.
 * Copy lives under `marketing.testimonials.*`.
 */
export async function TestimonialsMarquee() {
  const t = await getTranslations('marketing.testimonials');

  return (
    <section className="bg-surface/40 py-20 md:py-28">
      <Reveal className="mx-auto max-w-2xl px-4 text-center sm:px-6">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {t('title')}
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">{t('subtitle')}</p>
      </Reveal>

      <Reveal delay={120} className="mx-auto mt-14 w-full max-w-5xl px-4">
        {/* Desktop: photo with overlapping card */}
        <div className="hidden items-center md:flex">
          <div className="size-[470px] shrink-0 overflow-hidden rounded-3xl bg-surface-2">
            <Image
              src="/testimonial-gui.jpg"
              alt={t('a.name')}
              width={470}
              height={470}
              className="size-full object-cover"
              draggable={false}
            />
          </div>
          <div className="z-10 -ml-20 max-w-xl flex-1 rounded-3xl bg-background p-8 shadow-2xl">
            <h3 className="font-display text-2xl font-bold text-foreground">
              {t('a.name')}
            </h3>
            <p className="mt-2 text-sm font-medium text-muted-foreground">
              {t('a.role')}
            </p>
            <blockquote className="mt-6 text-base leading-relaxed text-foreground">
              {t('a.quote')}
            </blockquote>
            <div className="mt-8">
              <InstagramLink label={t('a.name')} />
            </div>
          </div>
        </div>

        {/* Mobile: stacked */}
        <div className="mx-auto max-w-sm text-center md:hidden">
          <div className="aspect-square w-full overflow-hidden rounded-3xl bg-surface-2">
            <Image
              src="/testimonial-gui.jpg"
              alt={t('a.name')}
              width={400}
              height={400}
              className="size-full object-cover"
              draggable={false}
            />
          </div>
          <div className="mt-6 px-4">
            <h3 className="font-display text-xl font-bold text-foreground">
              {t('a.name')}
            </h3>
            <p className="mt-2 text-sm font-medium text-muted-foreground">
              {t('a.role')}
            </p>
            <blockquote className="mt-4 text-sm leading-relaxed text-foreground">
              {t('a.quote')}
            </blockquote>
            <div className="mt-6 flex justify-center">
              <InstagramLink label={t('a.name')} />
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function InstagramLink({ label }: { label: string }) {
  return (
    <a
      href="#"
      target="_blank"
      rel="noopener noreferrer"
      className="flex size-12 items-center justify-center rounded-full bg-foreground text-background transition-transform hover:scale-105"
      aria-label={`Instagram — ${label}`}
    >
      {/* Instagram glyph — lucide-react no longer ships brand icons */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5"
        aria-hidden
      >
        <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
        <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
        <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
      </svg>
    </a>
  );
}
