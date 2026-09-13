import {
  DEFAULT_WASTE_BPS,
  productProfit,
  type HourlyRate,
  type ProductProfit,
} from '@/lib/calculations/profit-hour';
import type { SaleUnit } from '@/lib/validation/profit';

/**
 * Client-safe product shape for the Profit section (no DB imports), shared by the
 * server loader (lib/data/profit.ts), the ranking page and the live calculator.
 */

export type ProfitMissing = 'batchTime' | 'price' | 'ingredientPricing';

/** Everything the calculator and the ranking need for one product (a recipe). */
export type ProfitProduct = {
  id: string;
  name: string;
  saleUnit: SaleUnit | null;
  batchTimeMinutes: number | null;
  batchYield: number;
  sellingPriceCents: number | null;
  /** Ingredient cost of one batch after trim/loss; null when it can't be trusted. */
  ingredientCostPerBatchCents: number | null;
  packagingPerBatchCents: number;
  energyPerBatchCents: number;
  deliveryPerUnitCents: number;
  wasteBps: number | null;
  extraStepMinutes: number | null;
  extraStepPriceCents: number | null;
  missing: ProfitMissing[];
};

/** Hour Engine result for a product, or null while it is missing data. */
export function profitForProduct(
  product: ProfitProduct,
  rate: HourlyRate | null,
): ProductProfit | null {
  if (
    product.batchTimeMinutes == null ||
    product.sellingPriceCents == null ||
    product.ingredientCostPerBatchCents == null
  ) {
    return null;
  }
  return productProfit(
    {
      ingredientCostPerBatchCents: product.ingredientCostPerBatchCents,
      packagingPerBatchCents: product.packagingPerBatchCents,
      energyPerBatchCents: product.energyPerBatchCents,
      deliveryPerUnitCents: product.deliveryPerUnitCents,
      wasteBps: product.wasteBps ?? DEFAULT_WASTE_BPS,
      batchMinutes: product.batchTimeMinutes,
      batchYield: product.batchYield,
      sellingPriceCents: product.sellingPriceCents,
      extraStep:
        product.extraStepMinutes != null && product.extraStepPriceCents != null
          ? { minutes: product.extraStepMinutes, priceCents: product.extraStepPriceCents }
          : null,
    },
    rate,
  );
}
