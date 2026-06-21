import { getTranslations } from 'next-intl/server';
import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listIngredients, toKitchenIngredient } from '@/lib/data/ingredients';
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
  const [ingredientRows, settings, role] = await Promise.all([
    withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
    getOrgSettings(),
    getUserRole(),
  ]);

  // Kitchen sees no price — strip the financial columns from the payload (not just
  // the UI). The grid hides the Price column when `canSeeCosts` is false.
  const canSeeCosts = canSeeRecipeCosts(role);
  const ingredients = canSeeCosts
    ? ingredientRows
    : ingredientRows.map(toKitchenIngredient);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <IngredientGrid
        initialIngredients={ingredients}
        canSeeCosts={canSeeCosts}
        currency={settings.currency}
        highlightId={typeof highlight === 'string' ? highlight : undefined}
      />
    </div>
  );
}
