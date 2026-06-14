import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import type { NavKey } from '@/lib/nav';

/** Placeholder de módulo para o Sprint 0 — cada módulo ganha conteúdo real depois. */
export async function ComingSoon({ titleKey }: { titleKey: NavKey }) {
  const tNav = await getTranslations('nav');
  const tCommon = await getTranslations('common');

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-2xl font-semibold text-slate-900">
        {tNav(titleKey)}
      </h1>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{tCommon('comingSoon')}</CardTitle>
          <CardDescription>{tCommon('comingSoonDescription')}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
