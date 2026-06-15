import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listIngredients } from '@/lib/data/ingredients';
import { getOrgSettings } from '@/lib/data/org-settings';
import { IngredientGrid } from '@/components/app/ingredients/ingredient-grid';

export default async function IngredientsPage() {
  const t = await getTranslations('ingredients');
  const organizationId = await getOrgId();
  const [ingredients, settings] = await Promise.all([
    withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
    getOrgSettings(),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        {t('title')}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      <div className="mt-6">
        <IngredientGrid
          initialIngredients={ingredients}
          currency={settings.currency}
        />
      </div>
    </div>
  );
}
