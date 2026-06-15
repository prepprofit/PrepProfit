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
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <RecipeList initialRecipes={recipes} />
    </div>
  );
}
