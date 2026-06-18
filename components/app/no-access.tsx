import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

/**
 * Manager-only gate fallback. Manager-only routes render this (instead of
 * redirecting) when a kitchen-role user reaches them — a clear, localized
 * message with no redirect loop. The real enforcement is server-side in the
 * page (which renders this) and in every action (FORBIDDEN); this is the UX.
 *
 * Defaults to the finance copy; pass `title`/`body` for a route-specific
 * message (e.g. Settings, which isn't financial data).
 */
export async function NoAccess({
  title,
  body,
}: {
  title?: string;
  body?: string;
} = {}) {
  const t = await getTranslations('finance.noAccess');

  return (
    <div className="mx-auto max-w-2xl">
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{title ?? t('title')}</CardTitle>
          <CardDescription>{body ?? t('body')}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
