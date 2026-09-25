import { notFound } from 'next/navigation';
import { getOrgId } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getRecipeWorkspace } from '@/lib/data/recipe-workspace';
import { listRecipePresets } from '@/lib/data/recipe-presets';
import { getOrgSettings } from '@/lib/data/org-settings';
import { buildKitchenScaleDocument } from '@/lib/kitchen-scale/prep-document';
import { KitchenScaleWorkspace } from '@/components/app/kitchen-scale/kitchen-scale-workspace';

/**
 * Kitchen Scale calculator page (Kitchen Scale redesign §2). ALWAYS loads via
 * the literal `'kitchen'` workspace role — even for a manager — because Kitchen
 * Scale is not a financial surface: no money key ever reaches the client from
 * here. Full-width; the app sidebar auto-collapses on entry (`AppShell`).
 */
export default async function KitchenScaleRecipePage({
  params,
}: {
  params: Promise<{ recipeId: string }>;
}) {
  const { recipeId } = await params;
  const organizationId = await getOrgId();

  const [dto, presets, settings] = await Promise.all([
    withOrg(organizationId, (tx) =>
      getRecipeWorkspace(tx, organizationId, recipeId, 'kitchen'),
    ),
    withOrg(organizationId, (tx) =>
      listRecipePresets(tx, organizationId, recipeId),
    ),
    getOrgSettings(),
  ]);

  // Missing, trashed, or cross-org recipes all read as null under the org scope.
  if (!dto) notFound();

  const doc = buildKitchenScaleDocument(dto);

  return (
    <KitchenScaleWorkspace
      recipeId={recipeId}
      recipeName={doc.name}
      recipe={{ yieldPortions: doc.yieldPortions, yieldWeightGrams: doc.yieldWeightGrams }}
      lines={doc.lines}
      presets={presets.map((p) => ({
        id: p.id,
        name: p.name,
        targetWeightGrams: p.targetWeightGrams,
      }))}
      method={doc.method}
      legacyNotes={doc.legacyNotes}
      measurementSystem={settings.measurementSystem}
    />
  );
}
