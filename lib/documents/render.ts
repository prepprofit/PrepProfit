import { getTranslations } from 'next-intl/server';
import { getOrgName } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getInvoiceWithItems } from '@/lib/data/invoices';
import { getRecipeWithIngredients } from '@/lib/data/recipes';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { currentPeriodKey, type PeriodView } from '@/lib/finance/period';
import {
  buildInvoiceDocumentData,
  invoiceDocumentFilename,
} from './invoice-data';
import { buildInvoiceLabels } from './invoice-labels';
import { renderInvoicePdf } from './invoice-pdf';
import { buildRecipeCardData, recipeCardFilename } from './recipe-card-data';
import { buildRecipeCardLabels } from './recipe-card-labels';
import { renderRecipeCardPdf } from './recipe-card-pdf';
import { loadPlDocument, periodLabel } from './pl-loader';
import { buildPlLabels } from './pl-labels';
import { renderPlPdf } from './pl-pdf';
import { loadSafeLogo } from './logo';
import { documentFilename } from './format';
import { deriveScale } from '@/lib/calculations/recipeScale';
import type { DocumentEmailInput } from '@/lib/validation/document-email';

/**
 * Server-side document renderer shared by the email action (Sprint 3.5C). Given a
 * validated `documentType` + entity id/period and the org id (always derived
 * server-side, RULE #1), it loads inside `withOrg`, embeds an SSRF-safe logo, and
 * renders the SAME PDF the 3.5B download routes produce — so an emailed document is
 * byte-for-byte the downloadable one. A foreign / trashed / non-existent entity
 * yields `null`, which the action maps to `NOT_FOUND` (the email is never sent and
 * no other org's document is ever attached).
 */
export type RenderedDocument = {
  pdf: Buffer;
  /** Download filename including the `.pdf` extension. */
  filename: string;
  /** Audit `entity_type` for the resulting `document.email` event. */
  entityType: 'invoice' | 'recipe' | 'report';
  /** Audit `entity_id` (null for the period-based P&L report). */
  entityId: string | null;
  /** Human label for the email subject/body (invoice no., recipe name, period). */
  displayName: string;
};

export async function renderDocumentForEmail(
  organizationId: string,
  input: DocumentEmailInput,
): Promise<RenderedDocument | null> {
  switch (input.documentType) {
    case 'invoice': {
      const loaded = await withOrg(organizationId, async (tx) => {
        const detail = await getInvoiceWithItems(tx, organizationId, input.invoiceId);
        if (!detail) return null;
        const settings = await getOrgSettingsRow(tx, organizationId);
        return { detail, settings };
      });
      if (!loaded) return null;

      const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
      const orgName = settings.businessName?.trim() ? null : await getOrgName();
      const t = await getTranslations('invoiceDocument');
      const data = buildInvoiceDocumentData(loaded.detail, settings, orgName);
      data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

      const pdf = await renderInvoicePdf(data, buildInvoiceLabels(t));
      return {
        pdf,
        filename: `${invoiceDocumentFilename(loaded.detail.invoice)}.pdf`,
        entityType: 'invoice',
        entityId: input.invoiceId,
        displayName: loaded.detail.invoice.number ?? input.invoiceId,
      };
    }

    case 'recipeCard': {
      const loaded = await withOrg(organizationId, async (tx) => {
        const recipe = await getRecipeWithIngredients(tx, organizationId, input.recipeId);
        if (!recipe) return null;
        const settings = await getOrgSettingsRow(tx, organizationId);
        return { recipe, settings };
      });
      if (!loaded) return null;

      const settings = loaded.settings ?? DEFAULT_ORG_SETTINGS;
      const orgName = settings.businessName?.trim() ? null : await getOrgName();
      const t = await getTranslations('recipeCardDocument');
      // Mirror the scaled view the manager emailed from, if any.
      const scale =
        input.portions != null
          ? deriveScale(
              loaded.recipe.recipe.yieldPortions,
              { kind: 'portions', targetPortions: input.portions },
              loaded.recipe.lines.map((l) => l.quantity),
            )
          : null;
      if (scale && !scale.ok) return null;
      const data = buildRecipeCardData(loaded.recipe, settings, orgName, scale);
      data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

      const pdf = await renderRecipeCardPdf(data, buildRecipeCardLabels(t));
      const name = loaded.recipe.recipe.name;
      return {
        pdf,
        filename: `${documentFilename(recipeCardFilename(name))}.pdf`,
        entityType: 'recipe',
        entityId: input.recipeId,
        displayName: name,
      };
    }

    case 'pl': {
      const view = input.view as PeriodView;
      const periodKey = input.period ?? currentPeriodKey(view);
      const tCat = await getTranslations('finance.categories');
      const t = await getTranslations('plDocument');
      const data = await loadPlDocument({ view, periodKey, tCat });
      data.seller.logoUrl = await loadSafeLogo(data.seller.logoUrl);

      const pdf = await renderPlPdf(data, buildPlLabels(t));
      return {
        pdf,
        filename: `${documentFilename(`pl-${periodKey}`)}.pdf`,
        entityType: 'report',
        entityId: null,
        displayName: periodLabel(view, periodKey),
      };
    }
  }
}
