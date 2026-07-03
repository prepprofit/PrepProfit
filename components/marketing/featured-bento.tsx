import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import {
  Camera,
  FileSpreadsheet,
  FileText,
  Lock,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  Table2,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Reveal } from '@/components/marketing/reveal';
import { cn } from '@/lib/utils';

const MINI_BARS = [40, 58, 49, 66, 72, 61, 80, 74, 88];

/**
 * Bento feature grid (template's FeaturedSection layout): a 6-column grid of
 * half / third / full-span cards, each topped with a coded product mock. Copy
 * reuses `marketing.features.*` and `marketing.importExport.*`.
 */
export async function FeaturedBento() {
  const t = await getTranslations('marketing.features');
  const ti = await getTranslations('marketing.importExport');

  return (
    <section
      id="features"
      className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6 md:py-28 lg:px-8"
    >
      {/* Two-column section header (template pattern) */}
      <Reveal className="mb-12 grid grid-cols-1 gap-6 md:grid-cols-2 md:items-start">
        <h2 className="font-display text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          {t('title')}
        </h2>
        <p className="text-lg leading-relaxed text-muted-foreground md:pt-1">
          {t('subtitle')}
        </p>
      </Reveal>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-6">
        {/* Row 1 — two half-width cards */}
        <Reveal className="lg:col-span-3">
          <BentoCard
            title={t('costing.title')}
            body={t('costing.body')}
            visual={<CostingMock />}
            tall
          />
        </Reveal>
        <Reveal delay={90} className="lg:col-span-3">
          <BentoCard
            title={t('financials.title')}
            body={t('financials.body')}
            visual={<FinancialsMock />}
            tall
          />
        </Reveal>

        {/* Row 2 — three third-width cards */}
        <Reveal className="md:col-span-1 lg:col-span-2">
          <BentoCard
            title={t('ai.title')}
            body={t('ai.body')}
            visual={<AiMock />}
          />
        </Reveal>
        <Reveal delay={90} className="md:col-span-1 lg:col-span-2">
          <BentoCard
            title={t('imports.title')}
            body={t('imports.body')}
            visual={
              <ImportsMock
                labels={{
                  csv: ti('csv'),
                  excel: ti('excel'),
                  photo: ti('photo'),
                  pdf: ti('pdf'),
                }}
              />
            }
          />
        </Reveal>
        <Reveal delay={180} className="md:col-span-2 lg:col-span-2">
          <BentoCard
            title={t('operations.title')}
            body={t('operations.body')}
            visual={<OperationsMock />}
          />
        </Reveal>

        {/* Row 3 — full-width horizontal card */}
        <Reveal className="md:col-span-2 lg:col-span-6">
          <article className="group relative grid overflow-hidden rounded-2xl border border-border bg-surface transition-shadow duration-300 hover:shadow-lg hover:shadow-black/5 md:grid-cols-2">
            <div className="flex flex-col justify-center px-5 py-6 md:px-8">
              <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-brand-500/12 text-brand-600 dark:text-brand-400">
                <ShieldCheck className="size-5" aria-hidden />
              </div>
              <h3 className="font-display text-lg font-semibold text-foreground">
                {t('security.title')}
              </h3>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                {t('security.body')}
              </p>
            </div>
            <div className="relative flex items-center justify-center overflow-hidden bg-surface-2/40 p-6 md:p-8">
              <SecurityMock />
            </div>
          </article>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------ Bento card ------------------------------- */

function BentoCard({
  title,
  body,
  visual,
  tall = false,
}: {
  title: string;
  body: string;
  visual: ReactNode;
  tall?: boolean;
}) {
  return (
    <article
      className={cn(
        'group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface transition-shadow duration-300 hover:shadow-lg hover:shadow-black/5',
        tall && 'lg:min-h-[420px]',
      )}
    >
      {/* Visual area — fills remaining space, fades into the content strip */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-surface-2/40 p-5 pb-8">
        {visual}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent"
        />
      </div>

      {/* Content — pinned at the bottom, muted body flows inline (template) */}
      <div className="px-5 py-4">
        <h3 className="text-base leading-relaxed tracking-tight">
          <span className="font-display font-semibold text-foreground">
            {title}
          </span>{' '}
          <span className="text-muted-foreground">{body}</span>
        </h3>
      </div>
    </article>
  );
}

/* ----------------------------- Coded mocks ------------------------------- */
/* Representative sample figures only — clearly decorative (aria-hidden).    */

function CostingMock() {
  const rows = [
    { name: 'Flour', value: '$0.42' },
    { name: 'Tomato', value: '$0.88' },
    { name: 'Mozzarella', value: '$1.11' },
    { name: 'Basil', value: '$0.14' },
  ];
  return (
    <Card className="w-full max-w-sm p-4" aria-hidden>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Margherita Pizza
        </span>
        <Badge variant="positive">68%</Badge>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
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
      <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-xs">
        <span className="font-medium text-muted-foreground">Food cost</span>
        <span className="font-display font-semibold tabular-nums text-foreground">
          $2.41
        </span>
      </div>
    </Card>
  );
}

function FinancialsMock() {
  const max = Math.max(...MINI_BARS);
  return (
    <Card className="w-full max-w-sm p-4" aria-hidden>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Profit by month
        </span>
        <Badge variant="positive">+18%</Badge>
      </div>
      <div className="mt-3 flex h-24 items-end gap-1.5">
        {MINI_BARS.map((v, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-sm bg-accent-500/80 last:bg-accent-600"
            style={{ height: `${(v / max) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Break-even</span>
        <span className="font-display font-semibold tabular-nums text-foreground">
          $4,200
        </span>
      </div>
    </Card>
  );
}

function AiMock() {
  return (
    <Card className="w-full max-w-xs p-4" aria-hidden>
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
      <div className="mt-3 flex flex-col gap-1.5">
        <div className="h-2 w-3/4 rounded-full bg-surface-2" />
        <div className="h-2 w-full rounded-full bg-surface-2" />
        <div className="h-2 w-1/2 rounded-full bg-surface-2" />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-xs">
        <span className="text-muted-foreground">Confidence</span>
        <span className="font-display font-semibold tabular-nums text-brand-600 dark:text-brand-400">
          High
        </span>
      </div>
    </Card>
  );
}

function ImportsMock({
  labels,
}: {
  labels: { csv: string; excel: string; photo: string; pdf: string };
}) {
  const tiles = [
    { Icon: FileSpreadsheet, label: labels.csv, tone: 'accent' },
    { Icon: Table2, label: labels.excel, tone: 'brand' },
    { Icon: Camera, label: labels.photo, tone: 'accent' },
    { Icon: FileText, label: labels.pdf, tone: 'brand' },
  ] as const;
  return (
    <div className="grid w-full max-w-xs grid-cols-2 gap-2.5" aria-hidden>
      {tiles.map(({ Icon, label, tone }) => (
        <Card
          key={label}
          className="flex flex-col items-center gap-2 p-3 text-center"
        >
          <span
            className={
              tone === 'accent'
                ? 'flex size-8 items-center justify-center rounded-lg bg-accent-500/12 text-accent-600 dark:text-accent-400'
                : 'flex size-8 items-center justify-center rounded-lg bg-brand-500/12 text-brand-600 dark:text-brand-400'
            }
          >
            <Icon className="size-4" aria-hidden />
          </span>
          <span className="text-[11px] font-medium text-foreground">
            {label}
          </span>
        </Card>
      ))}
    </div>
  );
}

function OperationsMock() {
  const rows = [
    { Icon: ReceiptText, label: 'INV-2026-0142', value: 'Paid' },
    { Icon: Table2, label: 'Mozzarella · stock', value: '12 kg' },
    { Icon: ReceiptText, label: 'Payroll · June', value: '$6,840' },
  ] as const;
  return (
    <Card className="w-full max-w-xs p-4" aria-hidden>
      <ul className="flex flex-col gap-2.5">
        {rows.map(({ Icon, label, value }) => (
          <li
            key={label}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="flex min-w-0 items-center gap-2 text-foreground/80">
              <Icon className="size-3.5 shrink-0 text-accent-500" aria-hidden />
              <span className="truncate">{label}</span>
            </span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">
              {value}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-xs">
        <span className="text-muted-foreground">Low-stock alerts</span>
        <Badge variant="warning">2</Badge>
      </div>
    </Card>
  );
}

function SecurityMock() {
  const orgs = [
    { name: 'org_forno_sal', you: true },
    { name: 'org_tasca_porto', you: false },
    { name: 'org_doce_lisboa', you: false },
  ];
  return (
    <div className="flex w-full max-w-sm flex-col gap-2" aria-hidden>
      {orgs.map((org) => (
        <Card
          key={org.name}
          className={cn(
            'flex items-center justify-between px-4 py-3',
            !org.you && 'opacity-50',
          )}
        >
          <span className="flex items-center gap-2 text-xs font-medium text-foreground">
            <Lock
              className={cn(
                'size-3.5',
                org.you
                  ? 'text-brand-600 dark:text-brand-400'
                  : 'text-muted-foreground',
              )}
              aria-hidden
            />
            <span className="font-mono">{org.name}</span>
          </span>
          {org.you ? <Badge variant="positive">You</Badge> : null}
        </Card>
      ))}
    </div>
  );
}
