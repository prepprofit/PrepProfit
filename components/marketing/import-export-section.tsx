import { getTranslations } from 'next-intl/server';
import {
  FileSpreadsheet,
  FileText,
  Camera,
  Download,
  Table2,
  ReceiptText,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Reveal } from '@/components/marketing/reveal';

const TILES = [
  { Icon: FileSpreadsheet, key: 'csv', tone: 'accent' },
  { Icon: Table2, key: 'excel', tone: 'brand' },
  { Icon: Camera, key: 'photo', tone: 'accent' },
  { Icon: FileText, key: 'pdf', tone: 'brand' },
  { Icon: Download, key: 'xlsx', tone: 'accent' },
  { Icon: ReceiptText, key: 'invoices', tone: 'brand' },
] as const;

/**
 * Replaces the template's third-party "Integrations" cluster with an honest
 * "Import & export" section — same floating-tile visual, real capabilities.
 */
export async function ImportExportSection() {
  const t = await getTranslations('marketing.importExport');

  return (
    <section className="border-y border-border bg-surface/40">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 md:py-28 lg:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          {/* Left — copy */}
          <Reveal>
            <Badge variant="accent">{t('eyebrow')}</Badge>
            <h2 className="mt-5 font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
              {t('title')}
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
              {t('body')}
            </p>
          </Reveal>

          {/* Right — capability tile cluster */}
          <Reveal delay={120}>
            <div className="relative">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10 rounded-[2rem] opacity-60 blur-3xl"
                style={{
                  background:
                    'radial-gradient(60% 60% at 60% 40%, color-mix(in oklab, var(--color-accent-500) 16%, transparent), transparent)',
                }}
              />
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {TILES.map(({ Icon, key, tone }) => (
                  <Card
                    key={key}
                    interactive
                    className="flex flex-col items-center gap-3 p-5 text-center"
                  >
                    <span
                      className={
                        tone === 'accent'
                          ? 'flex size-11 items-center justify-center rounded-xl bg-accent-500/12 text-accent-600 dark:text-accent-400'
                          : 'flex size-11 items-center justify-center rounded-xl bg-brand-500/12 text-brand-600 dark:text-brand-400'
                      }
                    >
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <span className="text-xs font-medium text-foreground">
                      {t(key)}
                    </span>
                  </Card>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
