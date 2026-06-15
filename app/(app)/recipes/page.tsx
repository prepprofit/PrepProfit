import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listRecipes } from '@/lib/data/recipes';
import { RecipeList } from '@/components/app/recipes/recipe-list';

export default async function RecipesPage() {
  const t = await getTranslations('recipes');
  const organizationId = await getOrgId();
  const recipes = await withOrg(organizationId, (tx) =>
    listRecipes(tx, organizationId),
  );

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-2xl font-semibold text-foreground">
        {t('title')}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      <div className="mt-6">
        <RecipeList initialRecipes={recipes} />
      </div>
    </div>
  );
}
