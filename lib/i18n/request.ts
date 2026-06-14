import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { defaultLocale, isLocale } from './config';

/**
 * next-intl setup without locale routing: the language comes from a `locale`
 * cookie, falling back to the default (en). English is the only locale for now;
 * more can be added later without changing this wiring. All UI strings go through
 * next-intl — nothing hardcoded (CLAUDE.md rule).
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get('locale')?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : defaultLocale;

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
