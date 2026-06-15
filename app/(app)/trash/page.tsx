import { getTranslations } from 'next-intl/server';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listTrashedRecipes } from '@/lib/data/recipes';
import { listTrashedIngredients } from '@/lib/data/ingredients';
import { daysLeft } from '@/lib/trash';
import { TrashView } from '@/components/app/trash/trash-view';

export default async function TrashPage() {
  const t = await getTranslations('trash');
  const organizationId = await getOrgId();

  const [recipes, ingredients] = await Promise.all([
    withOrg(organizationId, (tx) => listTrashedRecipes(tx, organizationId)),
    withOrg(organizationId, (tx) => listTrashedIngredients(tx, organizationId)),
  ]);

  // Compute "days left" on the server so the client gets a plain, lean shape.
  const now = new Date();
  const toItem = (r: { id: string; name: string; deletedAt: Date | null }) => ({
    id: r.id,
    name: r.name,
    daysLeft: r.deletedAt ? daysLeft(r.deletedAt, now) : 0,
  });

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <TrashView
        recipes={recipes.map(toItem)}
        ingredients={ingredients.map(toItem)}
      />
    </div>
  );
}
