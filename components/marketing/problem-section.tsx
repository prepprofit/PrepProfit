import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Reveal } from '@/components/marketing/reveal';

const BEFORE_ICONS = {
  a: '/icons/recipes-everywhere.webp',
  b: '/icons/ingredient-prices-drift.webp',
  c: '/icons/margins-disappear-silently.webp',
  d: '/icons/pricing-becomes-guesswork.webp',
} as const;

const AFTER_ICONS = {
  a: '/icons/one-recipe-source-of-truth.webp',
  b: '/icons/update-one-cost.webp',
  c: '/icons/numbers-you-can-defend.webp',
  d: '/icons/price-with-confidence.webp',
} as const;

const CARDS = ['a', 'b', 'c', 'd'] as const;

/**
 * Problem section: the spreadsheet pain made visible as a before/after grid.
 * Copy lives under `marketing.problem.*`.
 */
export async function ProblemSection() {
  const t = await getTranslations('marketing.problem');

  return (
    <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {t('title')}
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">{t('subtitle')}</p>
      </Reveal>

      <div className="mt-14 grid gap-10 lg:grid-cols-2 lg:gap-8">
        <Reveal>
          <ProblemColumn
            heading={t('beforeTitle')}
            items={CARDS.map((c) => ({
              title: t(`before.${c}.title`),
              body: t(`before.${c}.body`),
              icon: BEFORE_ICONS[c],
            }))}
          />
        </Reveal>
        <Reveal delay={120}>
          <ProblemColumn
            heading={t('afterTitle')}
            items={CARDS.map((c) => ({
              title: t(`after.${c}.title`),
              body: t(`after.${c}.body`),
              icon: AFTER_ICONS[c],
            }))}
          />
        </Reveal>
      </div>
    </section>
  );
}

function ProblemColumn({
  heading,
  items,
}: {
  heading: string;
  items: { title: string; body: string; icon: string }[];
}) {
  return (
    <div className="flex h-full flex-col">
      <h3 className="mb-4 text-center font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <div className="grid flex-1 gap-3 sm:grid-cols-2 sm:gap-4">
        {items.map(({ title, body, icon }) => (
          <div
            key={title}
            className="group flex flex-col gap-3 rounded-2xl border border-transparent bg-background/40 p-5 transition-all duration-300 ease-out hover:-translate-y-1.5 hover:border-border hover:bg-background hover:shadow-lg"
          >
            <Image
              src={icon}
              alt=""
              width={96}
              height={96}
              className="size-24 object-contain drop-shadow-sm transition-transform duration-300 ease-out group-hover:scale-110"
              aria-hidden
            />
            <h4 className="font-display text-sm font-semibold text-foreground">
              {title}
            </h4>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
