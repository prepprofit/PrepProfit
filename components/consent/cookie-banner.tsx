'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  CONSENT_OPEN_EVENT,
  readConsent,
  subscribeConsent,
  writeConsent,
} from '@/lib/consent';

/**
 * GDPR/ePrivacy cookie banner: shown until the visitor makes a choice, and
 * reopenable via openConsentBanner() (footer / settings "Cookie settings").
 * Reject must be as easy as Accept, so both are equal-weight buttons and
 * there is no cookie wall — the site works fully either way.
 *
 * Consent is read via useSyncExternalStore, NOT a mount-effect setState: a
 * post-hydration setState cascade in the root layout crashes the Next router
 * on WebKit/iOS ("Rendered more hooks…", facebook/react#33580).
 */
export function CookieBanner({
  initialConsent,
}: {
  /** Consent cookie as read by the SERVER for this request — used as the
   * server snapshot so server HTML and first client render agree. A `null`
   * server snapshot while the cookie exists forces a sync re-render during
   * root-layout hydration, which crashes WebKit/iOS. */
  initialConsent: 'granted' | 'denied' | null;
}) {
  const t = useTranslations('consent');
  const consent = useSyncExternalStore(
    subscribeConsent,
    readConsent,
    () => initialConsent,
  );
  const [reopened, setReopened] = useState(false);

  useEffect(() => {
    // Event-handler setState (user click), not a hydration cascade.
    const reopen = () => setReopened(true);
    window.addEventListener(CONSENT_OPEN_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, reopen);
  }, []);

  if (consent !== null && !reopened) return null;

  const choose = (value: 'granted' | 'denied') => {
    writeConsent(value);
    setReopened(false);
  };

  return (
    <div
      role="dialog"
      aria-label={t('title')}
      className="fixed inset-x-0 bottom-0 z-50 p-4 sm:p-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 rounded-2xl border border-border bg-background p-5 shadow-2xl shadow-black/10 sm:flex-row sm:items-center">
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">{t('title')}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('body')}{' '}
            <Link
              href="/privacy"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {t('learnMore')}
            </Link>
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => choose('denied')}>
            {t('reject')}
          </Button>
          <Button size="sm" onClick={() => choose('granted')}>
            {t('accept')}
          </Button>
        </div>
      </div>
    </div>
  );
}
