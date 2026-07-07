'use client';

import * as React from 'react';
import Link from 'next/link';
import posthog from 'posthog-js';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { logError } from '@/lib/observability';

/**
 * Error boundary for every app module (within the root layout, so next-intl +
 * theme are available). Recoverable: `reset()` re-renders the segment. The
 * catastrophic, provider-less fallback is `app/global-error.tsx`.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors.boundary');

  React.useEffect(() => {
    logError({ action: 'app-error-boundary' }, error);
    // TEMPORARY: second capture path (only fires if PostHog already loaded)
    // while diagnosing the iPhone crash.
    if (posthog.__loaded) {
      posthog.captureException(error, { boundary: 'app-error' });
    }
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
            <AlertTriangle className="size-6" />
          </span>
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-lg font-semibold text-foreground">
              {t('title')}
            </h1>
            <p className="text-sm text-muted-foreground">{t('body')}</p>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button type="button" onClick={reset}>
              {t('retry')}
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard">{t('back')}</Link>
            </Button>
          </div>
          {/* TEMPORARY diagnostic panel for the iPhone WebKit crash investigation.
              Remove once the root cause is found. */}
          <div className="mt-2 w-full rounded-md bg-muted p-3 text-left font-mono text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
            <div>
              <strong>message:</strong> {error.message || '(empty)'}
            </div>
            {error.digest && (
              <div>
                <strong>digest:</strong> {error.digest}
              </div>
            )}
            <div className="mt-2">
              <strong>stack:</strong>
              {'\n'}
              {error.stack || '(no stack)'}
            </div>
            <div className="mt-2">
              <strong>ua:</strong>{' '}
              {typeof navigator !== 'undefined' ? navigator.userAgent : '(n/a)'}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
