import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { getProfitSettingsRow, loadProfitProducts, toHourlyRateInput } from '@/lib/data/profit';
import {
  rankCatalogue,
  summarizeCatalogue,
  trueHourlyRate,
} from '@/lib/calculations/profit-hour';
import { profitForProduct } from '@/lib/profit/product';
import { NoAccess } from '@/components/app/no-access';
import {
  ProfitCatalogue,
  type ProfitCatalogueRow,
} from '@/components/app/profit/profit-catalogue';

/**
 * Profit (Hour Engine) — the catalogue ranked by €/hour of hands-on production,
 * judged against the org's True Hourly Rate. Manager-only (fixed costs, owner
 * income and prices are financial data). The rate and every product result are
 * derived live from stored inputs, so an edited cost or price re-ranks on read.
 */
export default async function ProfitPage() {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const t = await getTranslations('profit');
  const organizationId = await getOrgId();
  const [settings, { settingsRow, products }] = await Promise.all([
    getOrgSettings(),
    withOrg(organizationId, async (tx) => ({
      settingsRow: await getProfitSettingsRow(tx, organizationId),
      products: await loadProfitProducts(tx, organizationId),
    })),
  ]);

  const rateInput = toHourlyRateInput(settingsRow);
  const rate = rateInput ? trueHourlyRate(rateInput) : null;

  const rows: ProfitCatalogueRow[] = rankCatalogue(
    products.map((product) => ({
      id: product.id,
      name: product.name,
      saleUnit: product.saleUnit,
      sellingPriceCents: product.sellingPriceCents,
      missing: product.missing,
      profit: profitForProduct(product, rate),
    })),
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('heroTitle')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('heroSubtitle')}</p>
      </div>
      <ProfitCatalogue
        rows={rows}
        summary={summarizeCatalogue(rows, rate)}
        rate={rate}
        currency={settings.currency}
      />
    </div>
  );
}
