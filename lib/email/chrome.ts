import { getTranslations } from 'next-intl/server';

/**
 * Shared email "chrome" (React Email migration): the brand name and footer lines
 * every template's {@link BaseEmail} shell needs, resolved from the `email` i18n
 * namespace ON THE SERVER (templates never call next-intl). The app is English-only
 * and these server contexts carry no request locale, so we resolve `en` explicitly,
 * mirroring lib/email/notifications.ts.
 *
 * The header is deliberately logo-LESS text (no `logoUrl`): we ship no marketing
 * imagery in transactional/report mail, and a text header can never break on a
 * missing asset. `BaseEmail` still accepts a `logoUrl` if a brand asset is added
 * to `public/static/emails/` later.
 */
export async function emailChrome(): Promise<{
  brandName: string;
  footerLines: string[];
}> {
  const t = await getTranslations({ locale: 'en', namespace: 'email' });
  return {
    brandName: t('brandName'),
    footerLines: [t('footer.tagline'), t('footer.auto')],
  };
}
