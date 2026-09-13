import { notFound } from 'next/navigation';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { getProfitSettingsRow, loadProfitProducts, toHourlyRateInput } from '@/lib/data/profit';
import { trueHourlyRate } from '@/lib/calculations/profit-hour';
import { NoAccess } from '@/components/app/no-access';
import { ProductProfitCalculator } from '@/components/app/profit/product-profit-calculator';

/**
 * Per-product Hour Engine calculator (Profit section, Part B). Manager-only. The
 * product is read through the same catalogue loader as the ranking, so the
 * ingredient cost (sub-recipes flattened, unpriced → unknown) matches exactly.
 */
export default async function ProfitProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const { id } = await params;
  const organizationId = await getOrgId();
  const [settings, { settingsRow, products }] = await Promise.all([
    getOrgSettings(),
    withOrg(organizationId, async (tx) => ({
      settingsRow: await getProfitSettingsRow(tx, organizationId),
      products: await loadProfitProducts(tx, organizationId),
    })),
  ]);

  const product = products.find((p) => p.id === id);
  if (!product) notFound();

  const rateInput = toHourlyRateInput(settingsRow);
  return (
    <ProductProfitCalculator
      product={product}
      rate={rateInput ? trueHourlyRate(rateInput) : null}
      currency={settings.currency}
    />
  );
}
