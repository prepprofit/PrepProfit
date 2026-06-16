import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

/**
 * Manager-only gate fallback. Financial routes render this (instead of
 * redirecting) when a kitchen-role user reaches them — a clear, localized
 * message with no redirect loop. The real enforcement is server-side in the
 * page (which renders this) and in every action (FORBIDDEN); this is the UX.
 */
export async function NoAccess() {
  const t = await getTranslations('finance.noAccess');

  return (
    <div className="mx-auto max-w-2xl">
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('body')}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
