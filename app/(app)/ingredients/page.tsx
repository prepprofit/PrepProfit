import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listIngredients } from '@/lib/data/ingredients';
import { getOrgSettings } from '@/lib/data/org-settings';
import { IngredientGrid } from '@/components/app/ingredients/ingredient-grid';

export default async function IngredientsPage({
  searchParams,
}: {
  searchParams: Promise<{ highlight?: string }>;
}) {
  const t = await getTranslations('ingredients');
  const organizationId = await getOrgId();
  const { highlight } = await searchParams;
  const [ingredients, settings] = await Promise.all([
    withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
    getOrgSettings(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <IngredientGrid
        initialIngredients={ingredients}
        currency={settings.currency}
        highlightId={typeof highlight === 'string' ? highlight : undefined}
      />
    </div>
  );
}
