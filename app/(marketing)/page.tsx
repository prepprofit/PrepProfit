import Link from 'next/link';
import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';

export default async function MarketingPage() {
  const t = await getTranslations('marketing');
  const tApp = await getTranslations('app');

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-5 md:px-10">
        <div className="flex items-center gap-2">
          <Image
            src="/logo_final.jpg"
            alt="PrepProfit"
            width={32}
            height={32}
            className="rounded-md"
          />
          <span className="font-display text-lg font-semibold text-slate-900">
            {tApp('name')}
          </span>
        </div>
        <Button asChild variant="ghost">
          <Link href="/sign-in">{t('ctaSecondary')}</Link>
        </Button>
      </header>

      <main className="mx-auto flex max-w-3xl flex-1 flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-4xl font-bold tracking-tight text-slate-900 md:text-5xl">
          {t('headline')}
        </h1>
        <p className="mt-6 max-w-xl text-lg text-slate-500">{t('subhead')}</p>
        <div className="mt-10">
          <Button asChild size="lg">
            <Link href="/sign-up">{t('ctaPrimary')}</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
