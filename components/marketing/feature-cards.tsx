import { getTranslations } from 'next-intl/server';
import { Calculator, LineChart, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Reveal } from '@/components/marketing/reveal';

const MINI_BARS = [40, 58, 49, 66, 72, 61, 80];

/**
 * Three feature cards, each topped with a small product-UI mock built from
 * primitives (mirrors the template's three screenshot cards). Copy reuses the
 * existing `marketing.features.*` namespace.
 */
export async function FeatureCards() {
  const t = await getTranslations('marketing.features');

  return (
    <section
      id="features"
      className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6 md:py-28 lg:px-8"
    >
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          {t('title')}
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">{t('subtitle')}</p>
      </Reveal>

      <div className="mt-14 grid gap-6 md:grid-cols-3">
        <Reveal>
          <FeatureCard
            Icon={Calculator}
            title={t('costing.title')}
            body={t('costing.body')}
            mock={<CostingMock />}
          />
        </Reveal>
        <Reveal delay={90}>
          <FeatureCard
            Icon={LineChart}
            title={t('financials.title')}
            body={t('financials.body')}
            mock={<FinancialsMock />}
          />
        </Reveal>
        <Reveal delay={180}>
          <FeatureCard
            Icon={Sparkles}
            title={t('ai.title')}
            body={t('ai.body')}
            mock={<AiMock />}
          />
        </Reveal>
      </div>
    </section>
  );
}

function FeatureCard({
  Icon,
  title,
  body,
  mock,
}: {
  Icon: typeof Calculator;
  title: string;
  body: string;
  mock: React.ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden p-0">
      <div className="border-b border-border bg-surface-2/40 p-5">{mock}</div>
      <div className="p-6">
        <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent-500/12 text-accent-600 dark:text-accent-400">
          <Icon className="size-5" aria-hidden />
        </div>
        <h3 className="font-display text-base font-semibold text-foreground">
          {title}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>
    </Card>
  );
}

/* ----------------------------- Mini UI mocks ----------------------------- */

function CostingMock() {
  const rows = [
    { name: 'Flour', value: '€0.42' },
    { name: 'Tomato', value: '€0.88' },
    { name: 'Mozzarella', value: '€1.11' },
  ];
  return (
    <Card className="flex flex-col gap-3 p-4" aria-hidden>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Margherita Pizza
        </span>
        <Badge variant="positive">68%</Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li
            key={r.name}
            className="flex items-center justify-between text-xs text-foreground/80"
          >
            <span>{r.name}</span>
            <span className="tabular-nums">{r.value}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-border pt-2 text-xs">
        <span className="font-medium text-muted-foreground">Food cost</span>
        <span className="font-display font-semibold tabular-nums text-foreground">
          €2.41
        </span>
      </div>
    </Card>
  );
}

function FinancialsMock() {
  const max = Math.max(...MINI_BARS);
  return (
    <Card className="flex flex-col gap-3 p-4" aria-hidden>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Profit by month
        </span>
        <Badge variant="positive">+18%</Badge>
      </div>
      <div className="flex h-20 items-end gap-1.5">
        {MINI_BARS.map((v, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-sm bg-accent-500/80 last:bg-accent-600"
            style={{ height: `${(v / max) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Break-even</span>
        <span className="font-display font-semibold tabular-nums text-foreground">
          €4,200
        </span>
      </div>
    </Card>
  );
}

function AiMock() {
  return (
    <Card className="flex flex-col gap-3 p-4" aria-hidden>
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent-500/12 text-accent-600 dark:text-accent-400">
          <Sparkles className="size-3.5" aria-hidden />
        </span>
        <span className="text-xs font-medium text-foreground">
          Recipe draft
        </span>
        <Badge variant="warning" className="ml-auto">
          Review
        </Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="h-2 w-3/4 rounded-full bg-surface-2" />
        <div className="h-2 w-full rounded-full bg-surface-2" />
        <div className="h-2 w-1/2 rounded-full bg-surface-2" />
      </div>
      <div className="flex items-center justify-between border-t border-border pt-2 text-xs">
        <span className="text-muted-foreground">Confidence</span>
        <span className="font-display font-semibold tabular-nums text-brand-600 dark:text-brand-400">
          High
        </span>
      </div>
    </Card>
  );
}
