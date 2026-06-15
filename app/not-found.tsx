import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * Branded 404. Rendered inside the root layout, so next-intl + theme are
 * available. Links home (marketing/dashboard routing is handled by middleware).
 */
export default function NotFound() {
  const t = useTranslations('errors.notFound');

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background p-6 text-center">
      <p className="font-display text-5xl font-semibold text-accent-700 dark:text-accent-400">
        404
      </p>
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-xl font-semibold text-foreground">
          {t('title')}
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">{t('body')}</p>
      </div>
      <Button asChild>
        <Link href="/">{t('home')}</Link>
      </Button>
    </div>
  );
}
