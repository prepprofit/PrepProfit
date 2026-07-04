import { getTranslations } from 'next-intl/server';
import { Check, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Reveal } from '@/components/marketing/reveal';

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
            tone="before"
            items={CARDS.map((c) => ({
              title: t(`before.${c}.title`),
              body: t(`before.${c}.body`),
            }))}
          />
        </Reveal>
        <Reveal delay={120}>
          <ProblemColumn
            heading={t('afterTitle')}
            tone="after"
            items={CARDS.map((c) => ({
              title: t(`after.${c}.title`),
              body: t(`after.${c}.body`),
            }))}
          />
        </Reveal>
      </div>
    </section>
  );
}

function ProblemColumn({
  heading,
  tone,
  items,
}: {
  heading: string;
  tone: 'before' | 'after';
  items: { title: string; body: string }[];
}) {
  const after = tone === 'after';
  return (
    <div className="flex h-full flex-col">
      <h3 className="mb-4 text-center font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <div className="grid flex-1 gap-3 sm:grid-cols-2">
        {items.map(({ title, body }) => (
          <Card
            key={title}
            className={
              after
                ? 'flex flex-col gap-2 border-accent-500/30 bg-surface p-5'
                : 'flex flex-col gap-2 bg-surface/60 p-5'
            }
          >
            <span
              className={
                after
                  ? 'flex size-7 items-center justify-center rounded-lg bg-brand-500/12 text-brand-600 dark:text-brand-400'
                  : 'flex size-7 items-center justify-center rounded-lg bg-surface-2 text-muted-foreground'
              }
            >
              {after ? (
                <Check className="size-4" aria-hidden />
              ) : (
                <X className="size-4" aria-hidden />
              )}
            </span>
            <h4 className="font-display text-sm font-semibold text-foreground">
              {title}
            </h4>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {body}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
