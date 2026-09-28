import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Camera, FileText } from 'lucide-react';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { listIngredientOptions } from '@/lib/data/ingredients';
import { getImportAllowances } from '@/lib/data/ai-usage';
import { NoAccess } from '@/components/app/no-access';
import { ImportAllowanceLine } from '@/components/app/import/import-allowance-line';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ImportWorkbench } from './import-workbench';

/**
 * Deterministic import (Sprint 4.5). Manager-only on the SERVER: kitchen-role
 * users get NoAccess here AND every action refuses (defense-in-depth). The page
 * passes the org currency so the preview grid formats money locally. The AI-assisted
 * methods (photo, supplier invoice) are listed here with their own monthly allowance
 * beside each one — display only, the upload routes enforce the caps.
 */
export default async function ImportPage() {
  const t = await getTranslations('import');

  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />;
  }

  const settings = await getOrgSettings();
  const organizationId = await getOrgId();
  const ingredientOptions = await withOrg(organizationId, (tx) =>
    listIngredientOptions(tx, organizationId),
  );

  // `null` per method = usage could not be loaded (shown as unavailable, never zero).
  const allowances = await getImportAllowances();

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <Card>
        <CardHeader>
          <CardTitle>{t('aiMethods.title')}</CardTitle>
          <CardDescription>{t('aiMethods.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface-2/50 p-4">
            <p className="text-sm font-medium text-foreground">{t('aiMethods.photo.title')}</p>
            <p className="text-xs text-muted-foreground">{t('aiMethods.photo.body')}</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/recipes/import/photo">
                <Camera className="size-4" />
                {t('aiMethods.photo.cta')}
              </Link>
            </Button>
            <ImportAllowanceLine method="photo" allowance={allowances.photo_recipe_extraction} />
          </div>
          <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface-2/50 p-4">
            <p className="text-sm font-medium text-foreground">{t('aiMethods.invoice.title')}</p>
            <p className="text-xs text-muted-foreground">{t('aiMethods.invoice.body')}</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/suppliers/invoices/import">
                <FileText className="size-4" />
                {t('aiMethods.invoice.cta')}
              </Link>
            </Button>
            <ImportAllowanceLine method="invoice" allowance={allowances.supplier_invoice_extraction} />
          </div>
        </CardContent>
      </Card>
      <ImportWorkbench
        currency={settings.currency}
        measurementSystem={settings.measurementSystem}
        ingredientOptions={ingredientOptions}
      />
    </div>
  );
}
