import { getTranslations } from 'next-intl/server';
import { Camera, FileDown, MonitorCheck, UserCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Reveal } from '@/components/marketing/reveal';

const EVIDENCE = [
  { key: 'screenshots', Icon: MonitorCheck },
  { key: 'reviewedAi', Icon: Camera },
  { key: 'exports', Icon: FileDown },
  { key: 'roles', Icon: UserCheck },
] as const;

/**
 * Proof section: honest product evidence instead of testimonials — a worked
 * costing example plus four evidence cards. Copy lives under
 * `marketing.proof.*`.
 */
export async function ProofSection() {
  const t = await getTranslations('marketing.proof');

  return (
    <section className="bg-surface/40">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
            {t('title')}
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">{t('subtitle')}</p>
        </Reveal>

        <div className="mt-14 grid gap-4 lg:grid-cols-2">
          {/* Worked example */}
          <Reveal className="h-full">
            <Card className="flex h-full flex-col justify-center gap-5 p-7 shadow-md md:p-8">
              <div className="flex items-center justify-between">
                <Badge variant="accent">{t('example.label')}</Badge>
                <span className="font-display text-sm font-semibold text-foreground">
                  {t('example.recipe')}
                </span>
              </div>
              <dl className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl bg-surface-2/60 px-3 py-4">
                  <dt className="text-xs text-muted-foreground">
                    {t('example.costLabel')}
                  </dt>
                  <dd className="mt-1 font-display text-xl font-semibold tabular-nums text-foreground">
                    {t('example.cost')}
                  </dd>
                </div>
                <div className="rounded-xl bg-surface-2/60 px-3 py-4">
                  <dt className="text-xs text-muted-foreground">
                    {t('example.priceLabel')}
                  </dt>
                  <dd className="mt-1 font-display text-xl font-semibold tabular-nums text-foreground">
                    {t('example.price')}
                  </dd>
                </div>
                <div className="rounded-xl bg-brand-500/10 px-3 py-4">
                  <dt className="text-xs text-muted-foreground">
                    {t('example.marginLabel')}
                  </dt>
                  <dd className="mt-1 font-display text-xl font-semibold tabular-nums text-brand-600 dark:text-brand-400">
                    {t('example.margin')}
                  </dd>
                </div>
              </dl>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t('example.note')}
              </p>
            </Card>
          </Reveal>

          {/* Evidence cards */}
          <Reveal delay={120} className="h-full">
            <div className="grid h-full gap-3 sm:grid-cols-2">
              {EVIDENCE.map(({ key, Icon }) => (
                <Card key={key} className="flex flex-col gap-2.5 p-5">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-accent-500/12 text-accent-600 dark:text-accent-400">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <h3 className="font-display text-sm font-semibold text-foreground">
                    {t(`cards.${key}.title`)}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {t(`cards.${key}.body`)}
                  </p>
                </Card>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
