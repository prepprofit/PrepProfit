import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { MarketingHeader } from '@/components/marketing/marketing-header';

export type LegalSection = {
  heading: string;
  /** Paragraphs; lines starting with "- " render as list items. */
  body: string[];
};

/**
 * Shared shell for the static legal documents (/terms, /privacy): marketing
 * header, prose column, minimal footer. Content comes from the next-intl
 * `legal.*` namespace as {heading, body[]} sections (via t.raw), so the
 * documents stay in the messages file like every other user-visible string.
 */
export async function LegalPage({
  title,
  lastUpdated,
  sections,
}: {
  title: string;
  lastUpdated: string;
  sections: LegalSection[];
}) {
  const t = await getTranslations('legal.common');
  const tApp = await getTranslations('app');

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <MarketingHeader productName={tApp('name')} />

      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-4 pb-20 pt-32 sm:px-6 md:pt-40">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
            {title}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">{lastUpdated}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('disclaimer')}
          </p>

          {sections.map((section) => (
            <section key={section.heading} className="mt-10">
              <h2 className="font-display text-xl font-semibold tracking-tight text-foreground">
                {section.heading}
              </h2>
              {groupBody(section.body).map((block, i) =>
                Array.isArray(block) ? (
                  <ul
                    key={i}
                    className="mt-3 list-disc space-y-1.5 pl-6 text-sm leading-relaxed text-muted-foreground"
                  >
                    {block.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p
                    key={i}
                    className="mt-3 text-sm leading-relaxed text-muted-foreground"
                  >
                    {block}
                  </p>
                ),
              )}
            </section>
          ))}

          <p className="mt-14 border-t border-border pt-8 text-sm text-muted-foreground">
            {t('questions')}{' '}
            <a
              href="mailto:info@prepprofit.com"
              className="text-foreground underline underline-offset-2"
            >
              info@prepprofit.com
            </a>
          </p>
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} {tApp('name')}</p>
          <div className="flex gap-4">
            <Link href="/" className="transition-colors hover:text-foreground">
              {t('backHome')}
            </Link>
            <Link
              href="/terms"
              className="transition-colors hover:text-foreground"
            >
              {t('termsLink')}
            </Link>
            <Link
              href="/privacy"
              className="transition-colors hover:text-foreground"
            >
              {t('privacyLink')}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Merge consecutive "- " lines into a single list block. */
function groupBody(body: string[]): (string | string[])[] {
  const blocks: (string | string[])[] = [];
  for (const line of body) {
    if (line.startsWith('- ')) {
      const last = blocks[blocks.length - 1];
      const item = line.slice(2);
      if (Array.isArray(last)) last.push(item);
      else blocks.push([item]);
    } else {
      blocks.push(line);
    }
  }
  return blocks;
}
