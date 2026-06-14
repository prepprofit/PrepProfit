import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { defaultLocale, isLocale } from './config';

/**
 * Setup de next-intl sem roteamento por locale (Sprint 0): o idioma vem de um
 * cookie `locale`, com fallback para o default (pt). Sprint 5 completa os 3
 * idiomas e o seletor de idioma. Todas as strings de UI passam por aqui —
 * nada hardcoded (regra do CLAUDE.md).
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
