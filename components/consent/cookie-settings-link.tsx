'use client';

import { useTranslations } from 'next-intl';
import { openConsentBanner } from '@/lib/consent';
import { cn } from '@/lib/utils';

/**
 * Reopens the cookie banner so consent can be changed at any time — GDPR
 * requires withdrawing consent to be as easy as giving it. Used in the
 * marketing footer and the app settings page.
 */
export function CookieSettingsLink({ className }: { className?: string }) {
  const t = useTranslations('consent');

  return (
    <button
      type="button"
      onClick={openConsentBanner}
      className={cn(
        'text-sm text-muted-foreground transition-colors hover:text-foreground',
        className,
      )}
    >
      {t('settingsLink')}
    </button>
  );
}
