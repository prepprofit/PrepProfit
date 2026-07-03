import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { listIngredientOptions } from '@/lib/data/ingredients';
import { getPhotoExtractionUsageThisMonth } from '@/lib/data/ai-usage';
import { NoAccess } from '@/components/app/no-access';
import { PhotoImportWorkbench } from './photo-workbench';

/**
 * AI photo recipe extraction (Sprint 4.7). Manager-only on the SERVER (defense-in-
 * depth — the upload route enforces the same 403): kitchen users get NoAccess. AI is
 * a UNIVERSAL feature (every tier, including free) — it is not entitlement-gated;
 * usage is metered per-org by the monthly quota at the upload route. Distinct from
 * `/import` (the deterministic file workbench). The extracted draft is always staged
 * for human review — never an automatic write (CLAUDE.md).
 */
export default async function PhotoImportPage() {
  const t = await getTranslations('recipes.importPhoto');

  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />;
  }

  const settings = await getOrgSettings();
  const organizationId = await getOrgId();
  const ingredientOptions = await withOrg(organizationId, (tx) =>
    listIngredientOptions(tx, organizationId),
  );
  // Proactive quota hint (availableNow so it never promises an already-reserved slot).
  // The upload route stays the authority — this is display only.
  const photoUsage = await getPhotoExtractionUsageThisMonth();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <PhotoImportWorkbench
        measurementSystem={settings.measurementSystem}
        ingredientOptions={ingredientOptions}
        photoUsage={photoUsage}
      />
    </div>
  );
}
