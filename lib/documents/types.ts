import type { InvoiceStatus } from '@/lib/db/schema';

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

/** Recipe card (cost sheet) view-model. Reuses the recipe cost/margin calcs. */
export type RecipeCardDocumentData = {
  seller: SellerIdentity;
  recipeName: string;
  yieldPortions: number;
  /** Usable yield after trim/loss (100 = no loss). */
  yieldPercentage: number;
  lines: RecipeCardLine[];
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
  ingredient: string;
  quantity: string;
  cost: string;
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
