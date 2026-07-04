import { getTranslations } from 'next-intl/server';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
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
        <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {t('title')}
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">{t('subtitle')}</p>
      </Reveal>

      <Reveal delay={120}>
        <Accordion
          type="single"
          collapsible
          defaultValue="q1"
          className="mt-12 flex flex-col gap-3"
        >
          {QUESTIONS.map((q) => (
            <AccordionItem
              key={q}
              value={q}
              className="rounded-xl border border-border bg-surface px-5 transition-colors last:border-b data-[state=open]:border-accent-500/40"
            >
              <AccordionTrigger className="font-display text-base font-semibold">
                {t(`${q}.q`)}
              </AccordionTrigger>
              <AccordionContent className="pr-8 text-[15px] leading-relaxed text-muted-foreground">
                {t(`${q}.a`)}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Reveal>
    </section>
  );
}
