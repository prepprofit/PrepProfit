import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { canSeeRecipeCosts, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import {
  getKitchenProduction,
  getManagerProduction,
  listProductionRecipeOptions,
  type ProductionLineBase,
} from '@/lib/data/productions';
import { getOrgSettings } from '@/lib/data/org-settings';
import {
  ProductionEditor,
  type EditorProductionLine,
} from '@/components/app/productions/production-editor';
import { ProductionPlannedView } from '@/components/app/productions/production-planned-view';
import { ProductionCompletedView } from '@/components/app/productions/production-completed-view';
import { ProductionRequirements } from '@/components/app/productions/production-requirements';
import { ProductionCostCard } from '@/components/app/productions/production-cost-card';

/**
 * Production detail. A DRAFT shows the editor (Plan action); a PLANNED production shows
 * a read-only view with Reopen + Complete (Sprint 11b); a COMPLETED/VOIDED production
 * shows the frozen snapshot (Sprint 11b — consumed quantities, lifecycle, Void for
 * managers). Only the manager sees the cost card (kitchen loads the money-free loader,
 * so no cost reaches the client — F4).
 */
export default async function ProductionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = await getOrgId();
  const canSeeCost = canSeeRecipeCosts(await getUserRole());
  const t = await getTranslations('productions');
  const settings = await getOrgSettings();

  const fallbackLabel = (reference: string | null, plannedFor: string | null): string =>
    reference ?? plannedFor ?? `${t('fallbackLabel')} ${id.slice(0, 8)}`;

  if (canSeeCost) {
    const [detail, recipeOptions] = await Promise.all([
      withOrg(organizationId, (tx) => getManagerProduction(tx, organizationId, id)),
      withOrg(organizationId, (tx) =>
        listProductionRecipeOptions(tx, organizationId),
      ),
    ]);
    if (!detail) notFound();
    const lines: ProductionLineBase[] = detail.lines;
    const label = fallbackLabel(detail.reference, detail.plannedFor);

    // Completed / voided: the frozen snapshot + the frozen manager cost card.
    if (detail.completion) {
      return (
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <ProductionCompletedView
            productionId={detail.id}
            expectedUpdatedAt={detail.updatedAt}
            label={label}
            status={detail.status as 'completed' | 'voided'}
            completion={detail.completion}
            lines={lines}
            notes={detail.notes}
            system={settings.measurementSystem}
            canVoid
          />
          <ProductionCostCard cost={detail.cost} currency={settings.currency} />
        </div>
      );
    }

    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        {detail.status === 'draft' ? (
          <ProductionEditor
            mode="edit"
            productionId={detail.id}
            expectedUpdatedAt={detail.updatedAt}
            initial={{
              reference: detail.reference,
              notes: detail.notes,
              plannedFor: detail.plannedFor,
              lines: lines.map(toEditorLine),
            }}
            recipeOptions={recipeOptions}
            canSeeCost
          />
        ) : (
          <ProductionPlannedView
            productionId={detail.id}
            expectedUpdatedAt={detail.updatedAt}
            label={label}
            plannedFor={detail.plannedFor}
            notes={detail.notes}
            lines={lines}
            canComplete={detail.explosion.complete && detail.plannedFor !== null}
          />
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <ProductionRequirements
              explosion={detail.explosion}
              system={settings.measurementSystem}
            />
          </div>
          <ProductionCostCard cost={detail.cost} currency={settings.currency} />
        </div>
      </div>
    );
  }

  const [detail, recipeOptions] = await Promise.all([
    withOrg(organizationId, (tx) => getKitchenProduction(tx, organizationId, id)),
    withOrg(organizationId, (tx) => listProductionRecipeOptions(tx, organizationId)),
  ]);
  if (!detail) notFound();
  const label = fallbackLabel(detail.reference, detail.plannedFor);

  // Completed / voided: the frozen snapshot, money-free. Kitchen may NOT void (D2).
  if (detail.completion) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <ProductionCompletedView
          productionId={detail.id}
          expectedUpdatedAt={detail.updatedAt}
          label={label}
          status={detail.status as 'completed' | 'voided'}
          completion={detail.completion}
          lines={detail.lines}
          notes={detail.notes}
          system={settings.measurementSystem}
          canVoid={false}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      {detail.status === 'draft' ? (
        <ProductionEditor
          mode="edit"
          productionId={detail.id}
          expectedUpdatedAt={detail.updatedAt}
          initial={{
            reference: detail.reference,
            notes: detail.notes,
            plannedFor: detail.plannedFor,
            lines: detail.lines.map(toEditorLine),
          }}
          recipeOptions={recipeOptions}
          canSeeCost={false}
        />
      ) : (
        <ProductionPlannedView
          productionId={detail.id}
          expectedUpdatedAt={detail.updatedAt}
          label={label}
          plannedFor={detail.plannedFor}
          notes={detail.notes}
          lines={detail.lines}
          canComplete={detail.explosion.complete && detail.plannedFor !== null}
        />
      )}

      <ProductionRequirements
        explosion={detail.explosion}
        system={settings.measurementSystem}
      />
    </div>
  );
}

function toEditorLine(line: ProductionLineBase): EditorProductionLine {
  return {
    recipeId: line.recipeId,
    recipeName: line.recipeName,
    plannedQty: line.plannedQty,
    available: line.available,
  };
}
