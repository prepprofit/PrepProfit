import { getTranslations } from 'next-intl/server';
import { Plus } from 'lucide-react';
import { Reveal } from '@/components/marketing/reveal';

const QUESTIONS = ['q1', 'q2', 'q3', 'q4', 'q5'] as const;

export async function FaqSection() {
  const t = await getTranslations('marketing.faq');

  return (
    <section
      id="faq"
      className="mx-auto max-w-3xl scroll-mt-20 px-4 py-20 sm:px-6 md:py-28 lg:px-8"
    >
      <Reveal className="text-center">
        <h2 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          {t('title')}
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">{t('subtitle')}</p>
      </Reveal>

      <div className="mt-12 divide-y divide-border border-y border-border">
        {QUESTIONS.map((q) => (
          <details key={q} className="group py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-left font-display text-base font-semibold text-foreground transition-colors hover:text-accent-700 dark:hover:text-accent-400 [&::-webkit-details-marker]:hidden">
              {t(`${q}.q`)}
              <Plus
                className="size-5 shrink-0 text-muted-foreground transition-transform duration-300 group-open:rotate-45"
                aria-hidden
              />
            </summary>
            <p className="pb-4 pr-9 text-[15px] leading-relaxed text-muted-foreground">
              {t(`${q}.a`)}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
