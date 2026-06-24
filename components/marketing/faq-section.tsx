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

      <div className="mt-12 flex flex-col gap-3">
        {QUESTIONS.map((q, i) => (
          <details
            key={q}
            open={i === 0}
            className="group overflow-hidden rounded-xl border border-border bg-surface transition-colors open:border-accent-500/40 open:bg-gradient-to-br open:from-accent-50 open:to-surface dark:open:from-accent-500/10 dark:open:to-surface"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-left font-display text-base font-semibold text-foreground [&::-webkit-details-marker]:hidden">
              {t(`${q}.q`)}
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition-transform duration-300 group-open:rotate-45 group-open:bg-accent-500 group-open:text-white">
                <Plus className="size-4" aria-hidden />
              </span>
            </summary>
            <p className="px-5 pb-5 pr-12 text-[15px] leading-relaxed text-muted-foreground">
              {t(`${q}.a`)}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
