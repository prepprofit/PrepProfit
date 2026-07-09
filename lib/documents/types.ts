import type { InvoiceStatus } from '@/lib/db/schema';
import type { AllergenSlug, Presence } from '@/lib/allergens/catalog';

/**
 * Shared document view-models (Sprint 3.5A). Both the PDF renderer
 * (lib/documents/invoice-pdf.tsx) and the HTML print view
 * (app/(app)/invoices/[id]/print) consume the SAME `InvoiceDocumentData`, built
 * once by the pure `buildInvoiceDocumentData` (lib/documents/invoice-data.ts), so
 * the two surfaces can never drift.
 *
 * All money is integer cents; `taxRatePercent` is a percentage (e.g. 23). Line
 * net/tax/gross are computed with the shared `lineTotals` so the printed figures
 * reconcile with the invoice's frozen totals.
 */

/** The business issuing the invoice (the "From" block). */
export type SellerIdentity = {
  /** Resolved display name: org settings `businessName`, else the Clerk org name. */
  name: string;
  address: string | null;
  taxId: string | null;
  email: string | null;
  /** https-only URL (validated in lib/validation/org-settings.ts), or null. */
  logoUrl: string | null;
};

/** The frozen customer snapshot (the "Bill to" block). */
export type CustomerBlock = {
  name: string | null;
  taxId: string | null;
  address: string | null;
  email: string | null;
};

/** One rendered invoice line, with its independently-rounded amounts in cents. */
export type DocumentLine = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRatePercent: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
};

/**
 * Localized strings for an invoice document. Resolved by the caller (route / print
 * page) via next-intl and passed in, so the PDF component and print view stay free
 * of the i18n runtime and render identically.
 */
export type InvoiceDocumentLabels = {
  title: string;
  from: string;
  billTo: string;
  invoiceNo: string;
  issued: string;
  due: string;
  taxId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
  subtotal: string;
  tax: string;
  total: string;
  notes: string;
  status: Record<InvoiceStatus, string>;
};

/** Everything a generated invoice document needs, with no DB/I/O coupling. */
export type InvoiceDocumentData = {
  seller: SellerIdentity;
  customer: CustomerBlock;
  /** Formatted invoice number, or null while still a draft. */
  number: string | null;
  status: InvoiceStatus;
  /** Bare 'YYYY-MM-DD' strings (or null). */
  issueDate: string | null;
  dueDate: string | null;
  notes: string | null;
  /** ISO-4217 currency code used to format every amount. */
  currency: string;
  lines: DocumentLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

/* -------------------------------------------------------------------------- */
/* Sprint 3.5B report documents                                               */
/* -------------------------------------------------------------------------- */

/** One ingredient line on a recipe card, with its share of the cost. */
export type RecipeCardLine = {
  name: string;
  /** 'weight' | 'volume' | 'count' — drives the unit label. */
  dimension: 'weight' | 'volume' | 'count';
  /** Canonical amount used (g / ml / pieces). */
  quantity: number;
  /** Cost of this line, in integer cents. */
  costCents: number;
};

/**
 * Scale metadata stamped onto a document when it was resized (Recipe scaling MVP).
 * `null` on an unscaled document. `factor` and `scaledPortions` are pre-rounded for
 * display; the underlying figures are scaled with unrounded math before rounding.
 */
export type RecipeScaleMeta = {
  /** Multiplier applied to the original batch (e.g. 5, 0.5, 2.5). */
  factor: number;
  /** Resulting portions (may be fractional in anchor mode). */
  scaledPortions: number;
};

/** One sub-recipe component line on a recipe card (finished grams + line cost). */
export type RecipeCardComponentLine = {
  name: string;
  /** Grams of the component recipe's finished output used (scaled if scaled). */
  quantityGrams: number;
  /** Rounded line cost in integer cents, or null when unresolvable (renders "—"). */
  costCents: number | null;
};

/** Recipe card (cost sheet) view-model. Reuses the recipe cost/margin calcs. */
export type RecipeCardDocumentData = {
  seller: SellerIdentity;
  recipeName: string;
  yieldPortions: number;
  /** Usable yield after trim/loss (100 = no loss). */
  yieldPercentage: number;
  /** Present only when the card was scaled; drives the "Scaled to …" header line. */
  scale: RecipeScaleMeta | null;
  lines: RecipeCardLine[];
  /** Sub-recipe component lines (may be empty). Rendered as a separate section. */
  components: RecipeCardComponentLine[];
  ingredientCostCents: number;
  laborCostCents: number;
  energyCostCents: number;
  packagingCostCents: number;
  totalCostCents: number;
  costPerPortionCents: number;
  /** Selling price per portion, or null if unset. */
  sellingPriceCents: number | null;
  /** Gross margin %, or null when no selling price is set. */
  marginPercent: number | null;
  notes: string | null;
  currency: string;
};

export type RecipeCardDocumentLabels = {
  title: string;
  yield: string;
  portions: string;
  usableYield: string;
  /** "Scaled to {portions} portions (×{factor})" — only shown when scaled. */
  scaledTo: (args: { portions: string; factor: string }) => string;
  ingredient: string;
  quantity: string;
  cost: string;
  /** Section title for the sub-recipe component lines. */
  subRecipes: string;
  ingredientCost: string;
  labor: string;
  energy: string;
  packaging: string;
  totalCost: string;
  costPerPortion: string;
  sellingPrice: string;
  margin: string;
  notes: string;
  /** Unit suffix by dimension (e.g. g / ml / ×). */
  units: Record<'weight' | 'volume' | 'count', string>;
};

/** A category or product total row for the P&L document. */
export type PlTotalRow = {
  name: string;
  totalCents: number;
};

/** One month's figures for the P&L year view. */
export type PlMonthlyRow = {
  label: string;
  incomeCents: number;
  expenseCents: number;
  profitCents: number;
};

/** P&L (income statement) view-model. Mirrors the /financials aggregates. */
export type PlDocumentData = {
  seller: SellerIdentity;
  /** Human period label, e.g. 'June 2026' or '2026'. */
  periodLabel: string;
  view: 'month' | 'year';
  incomeCents: number;
  expenseCents: number;
  profitCents: number;
  byCategory: { name: string; kind: 'income' | 'expense'; totalCents: number }[];
  topProducts: PlTotalRow[];
  /** Present only in the year view (12 monthly rows), else null. */
  monthly: PlMonthlyRow[] | null;
  currency: string;
};

export type PlDocumentLabels = {
  title: string;
  period: string;
  income: string;
  expenses: string;
  profit: string;
  byCategory: string;
  category: string;
  amount: string;
  topProducts: string;
  product: string;
  monthly: string;
  month: string;
  empty: string;
};

/** One employee's totals on the payroll summary. */
export type PayrollDocumentRow = {
  name: string;
  shiftCount: number;
  workedMinutes: number;
  payDueCents: number;
};

/** Payroll period summary view-model. Mirrors the /payroll aggregates. */
export type PayrollDocumentData = {
  seller: SellerIdentity;
  periodLabel: string;
  view: 'week' | 'month';
  rows: PayrollDocumentRow[];
  totalShiftCount: number;
  totalWorkedMinutes: number;
  totalPayCents: number;
  currency: string;
};

export type PayrollDocumentLabels = {
  title: string;
  period: string;
  employee: string;
  shifts: string;
  hours: string;
  pay: string;
  total: string;
  empty: string;
};

/* -------------------------------------------------------------------------- */
/* Recipe scaling MVP — operational prep card (money-free, BOTH roles)         */
/* -------------------------------------------------------------------------- */

/** One ingredient line on the prep card — name + dimension + scaled quantity ONLY. */
export type RecipePrepCardLine = {
  name: string;
  dimension: 'weight' | 'volume' | 'count';
  /** Canonical amount (g / ml / pieces), already scaled if the card was scaled. */
  quantity: number;
};

/**
 * Operational prep-card view-model (Recipe scaling MVP). Deliberately money-free —
 * it carries NO cost, price, margin, or total key, by TYPE, so it can be shown to
 * kitchen and managers alike. It is the print/download counterpart for the kitchen,
 * distinct from the manager-only financial recipe cost sheet.
 */
export type RecipePrepCardData = {
  seller: SellerIdentity;
  recipeName: string;
  /** The recipe's own batch size (unscaled). */
  yieldPortions: number;
  /** Usable yield after trim/loss (100 = no loss). */
  yieldPercentage: number;
  /** Present only when scaled; drives the "Scaled to …" header line. */
  scale: RecipeScaleMeta | null;
  lines: RecipePrepCardLine[];
  /** Sub-recipe component lines — name + finished grams ONLY (money-free). */
  components: { name: string; quantityGrams: number }[];
  notes: string | null;
};

export type RecipePrepCardLabels = {
  title: string;
  yield: string;
  portions: string;
  usableYield: string;
  /** "Scaled to {portions} portions (×{factor})" — only shown when scaled. */
  scaledTo: (args: { portions: string; factor: string }) => string;
  ingredient: string;
  quantity: string;
  /** Section title for the sub-recipe component lines. */
  subRecipes: string;
  notes: string;
  /** Unit suffix by dimension (e.g. g / ml / ×). */
  units: Record<'weight' | 'volume' | 'count', string>;
};

/* -------------------------------------------------------------------------- */
/* Sprint 8a — purchase order document                                        */
/* -------------------------------------------------------------------------- */

import type { PurchaseOrderStatus } from '@/lib/db/schema';

/** The supplier a PO is addressed to (snapshot when sent, else the live link). */
export type SupplierBlock = {
  name: string | null;
  taxId: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
};

/** One purchase-order line, with its canonical quantity + negotiated cost. */
export type PurchaseOrderDocumentLine = {
  name: string;
  dimension: 'weight' | 'volume' | 'count';
  /** Canonical amount ordered (g / ml / pieces). */
  quantity: number;
  /** Negotiated cost per priced unit (per kg / litre / piece), integer cents. */
  unitCostCents: number;
  lineTotalCents: number;
};

/** Purchase-order document view-model (Sprint 8a). No DB/I/O coupling. */
export type PurchaseOrderDocumentData = {
  seller: SellerIdentity;
  supplier: SupplierBlock;
  /** Presentation number, e.g. 'PO-0001'. */
  number: string;
  status: PurchaseOrderStatus;
  /** True while a draft — the PDF/print render live data and a DRAFT watermark. */
  isDraft: boolean;
  /** Bare 'YYYY-MM-DD' strings (or null). */
  orderDate: string | null;
  expectedDate: string | null;
  notes: string | null;
  currency: string;
  lines: PurchaseOrderDocumentLine[];
  subtotalCents: number;
  totalCents: number;
};

export type PurchaseOrderDocumentLabels = {
  title: string;
  from: string;
  supplierTo: string;
  poNo: string;
  orderDate: string;
  expectedDate: string;
  taxId: string;
  phone: string;
  ingredient: string;
  quantity: string;
  unitCost: string;
  lineTotal: string;
  subtotal: string;
  total: string;
  notes: string;
  status: Record<PurchaseOrderStatus, string>;
  /** Unit suffix by dimension (e.g. g / ml / ×). */
  units: Record<'weight' | 'volume' | 'count', string>;
};

/* -------------------------------------------------------------------------- */
/* Sprint 9 — kitchen allergen matrix (OPERATIONAL, money-free)               */
/* -------------------------------------------------------------------------- */

/** One recipe row in the allergen matrix: effective presence per shown allergen. */
export type AllergenMatrixRow = {
  recipeName: string;
  /** Effective presence per allergen column; absent key = not present. */
  cells: Partial<Record<AllergenSlug, Presence>>;
  /** True if any ingredient on the recipe is unreviewed (warns, never "free"). */
  hasUnreviewedIngredient: boolean;
};

/**
 * Kitchen allergen matrix view-model (Sprint 9). Recipe × allergen, OPERATIONAL —
 * it carries NO monetary key or value (it replaces the manager-only cost card for
 * the kitchen's allergen needs). `allergens` are the columns actually present
 * across the org's recipes, in catalog order; `rows` are the active recipes.
 */
export type AllergenMatrixData = {
  seller: SellerIdentity;
  /** Allergen columns present anywhere, catalog-sorted (may be empty). */
  allergens: AllergenSlug[];
  rows: AllergenMatrixRow[];
  /** Bare 'YYYY-MM-DD' generation date. */
  generatedOn: string;
};

export type AllergenMatrixLabels = {
  title: string;
  generatedOn: string;
  recipe: string;
  /** Non-legal disclaimer — load-bearing; printed on every surface. */
  disclaimer: string;
  /** Shown when the org has recorded no allergens at all (never "allergen-free"). */
  noAllergensRecorded: string;
  /** Marker text per presence level (e.g. "Contains" / "May contain"). */
  presence: Record<Presence, string>;
  /** "Unreviewed ingredients" warning note for a recipe. */
  unreviewed: string;
  /** Per-allergen column labels, keyed by slug. */
  allergenLabels: Record<AllergenSlug, string>;
};
