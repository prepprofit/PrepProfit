import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LegalPage, type LegalSection } from '@/components/legal/legal-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal.terms');
  return { title: `${t('title')} — PrepProfit` };
}

export default async function TermsPage() {
  const t = await getTranslations('legal.terms');
  const sections = t.raw('sections') as LegalSection[];

  return (
    <LegalPage
      title={t('title')}
      lastUpdated={t('lastUpdated')}
      sections={sections}
    />
  );
}
