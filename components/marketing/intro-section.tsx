import { getTranslations } from 'next-intl/server';
import { Check, Layers, TrendingUp, Boxes, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Reveal } from '@/components/marketing/reveal';

const PANELS = [
  { Icon: Layers, key: 'recipes', value: '128' },
  { Icon: TrendingUp, key: 'margin', value: '64%' },
  { Icon: Boxes, key: 'inventory', value: '312' },
  { Icon: ShieldCheck, key: 'isolation', value: '100%' },
] as const;

/**
 * "Everything you need" intro — a product-UI mock panel on the left and the
 * positioning copy on the right (mirrors the template's about block).
 */
export async function IntroSection() {
  const t = await getTranslations('marketing.intro');
  const tp = await getTranslations('marketing.preview');

  return (
    <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        {/* Left — UI mock */}
        <Reveal>
          <div className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] opacity-60 blur-3xl"
              style={{
                background:
                  'radial-gradient(60% 60% at 30% 30%, color-mix(in oklab, var(--color-brand-500) 18%, transparent), transparent)',
              }}
            />
            <Card variant="glass" className="p-5 shadow-xl sm:p-6">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-display text-sm font-semibold text-foreground">
                  {t('title')}
                </span>
                <Badge variant="neutral">{tp('tag')}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {PANELS.map(({ Icon, key, value }) => (
                  <Card key={key} className="flex flex-col gap-2 p-4">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-accent-500/12 text-accent-600 dark:text-accent-400">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="font-display text-2xl font-semibold tabular-nums text-foreground">
                      {value}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(`panel.${key}`)}
                    </span>
                  </Card>
                ))}
              </div>
            </Card>
          </div>
        </Reveal>

        {/* Right — copy */}
        <Reveal delay={120}>
          <Badge variant="accent">{t('eyebrow')}</Badge>
          <h2 className="mt-5 font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            {t('title')}
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            {t('body')}
          </p>
          <ul className="mt-7 flex flex-col gap-4">
            {(['b1', 'b2', 'b3'] as const).map((k) => (
              <li key={k} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-600 dark:text-brand-400">
                  <Check className="size-3" aria-hidden />
                </span>
                <span className="text-foreground/90">{t(k)}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
