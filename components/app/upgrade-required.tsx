import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Paid-feature gate fallback (Sprint 4). A manager-only page renders this when
 * the org's plan doesn't include the feature — the same place that, server-side,
 * also blocks the actions/routes (UPGRADE_REQUIRED / 402). UI hiding is never the
 * control; this is just the UX, with a link to the plans page.
 *
 * Pass `body` for a feature-specific message; the default is generic.
 */
export async function UpgradeRequired({ body }: { body?: string } = {}) {
  const t = await getTranslations('entitlements.upgrade');

  return (
    <div className="mx-auto max-w-2xl">
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{body ?? t('body')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/pricing">{t('cta')}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
