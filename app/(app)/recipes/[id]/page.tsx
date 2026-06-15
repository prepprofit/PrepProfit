import { notFound } from 'next/navigation';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getRecipeWithIngredients } from '@/lib/data/recipes';
import { listIngredients } from '@/lib/data/ingredients';
import { getOrgSettings } from '@/lib/data/org-settings';
import { RecipeEditor } from '@/components/app/recipes/recipe-editor';

export default async function RecipeEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = await getOrgId();

  const [data, ingredients, settings] = await Promise.all([
    withOrg(organizationId, (tx) =>
      getRecipeWithIngredients(tx, organizationId, id),
    ),
    withOrg(organizationId, (tx) => listIngredients(tx, organizationId)),
    getOrgSettings(),
  ]);

  if (!data) notFound();

  return (
    <RecipeEditor
      recipe={data.recipe}
      initialLines={data.lines}
      ingredients={ingredients}
      currency={settings.currency}
      measurementSystem={settings.measurementSystem}
    />
  );
}
