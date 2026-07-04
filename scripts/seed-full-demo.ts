import { and, eq } from 'drizzle-orm';
import {
  withOrg,
  ingredients,
  recipes,
  recipeIngredients,
  recipePresets,
  recipeFolders,
  transactions,
  sales,
  saleItems,
  invoices,
  invoiceItems,
  customers,
  menus,
  menuItems,
  productions,
  productionItems,
  purchaseOrders,
  purchaseOrderItems,
  supplierInvoiceImports,
  supplierInvoiceImportLines,
  receipts,
  receiptItems,
  stockCounts,
  stockCountItems,
  tasks,
  taskLists,
  shifts,
  employees,
  suppliers,
  ingredientSuppliers,
  ingredientAllergens,
  recipeAllergenOverrides,
  ingredientPriceHistory,
  profitInsights,
  type TenantTx,
} from '../lib/db';
import { recordMovement } from '../lib/data/inventory';
import { ensureDefaultArea, createArea } from '../lib/data/storage-areas';
import {
  ensureCategoriesSeeded,
  listCategories,
} from '../lib/data/transaction-categories';
import { createSupplier } from '../lib/data/suppliers';
import { setDefaultSupplier } from '../lib/data/ingredient-suppliers';
import { replaceIngredientAllergens } from '../lib/data/allergens';
import { createCustomer } from '../lib/data/customers';
import {
  createDraftInvoice,
  issueInvoice,
  markInvoicePaid,
} from '../lib/data/invoices';
import { createEmployee } from '../lib/data/employees';
import { createShift } from '../lib/data/shifts';
import { createMenu } from '../lib/data/menus';
import { createTaskList, addTask } from '../lib/data/tasks';
import { createSale } from '../lib/data/sales';
import { createProduction, planProduction } from '../lib/data/productions';
import {
  createDraftPurchaseOrder,
  sendPurchaseOrder,
} from '../lib/data/purchase-orders';
import type { AllergenSlug } from '../lib/allergens/catalog';

/**
 * FULL DEMO SEED — populate ONE organization with a rich, English, demo-ready
 * dataset across (almost) every business module so screenshots and client demos
 * look complete: recipes, ingredients, inventory ledger, allergens, suppliers +
 * default links, menus, productions, sales, customers, invoices (draft/issued/
 * paid), employees + shifts (payroll), tasks, purchase orders, and 12 months of
 * finances.
 *
 *   SEED_ORG=org_xxx npm run seed:full
 *   npm run seed:full -- org_xxx
 *
 * WIPE + REBUILD, wrapped in a single `withOrg` transaction — ATOMIC: any error
 * rolls the whole thing back and production is left untouched. Only the target
 * org's rows are ever read or written (org-scoped + RLS). It does NOT touch
 * audit_log, subscriptions, or AI-usage attempt history.
 */

function loadEnv() {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // optional when DATABASE_URL is already in the environment
  }
}

const ORG = process.env.SEED_ORG ?? process.argv[2];

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
};
const daysFromNow = (n: number) => daysAgo(-n);

// ── Suppliers (10) ────────────────────────────────────────────────────────────
const SUPPLIERS = [
  { name: 'Northwind Flour Mills', email: 'orders@northwindflour.com', phone: '+351 210 111 222' },
  { name: 'Bercy Dairy Co', email: 'sales@bercydairy.com', phone: '+351 210 333 444' },
  { name: 'Sweet & Salt Supplies', email: 'hello@sweetandsalt.com', phone: '+351 210 555 666' },
  { name: 'Cocoa Barry Depot', email: 'depot@cocoabarry.com', phone: '+351 210 777 888' },
  { name: 'Valley Farm Eggs', email: 'farm@valleyfarm.com', phone: '+351 210 999 000' },
  { name: 'Olea Oil Imports', email: 'imports@oleaoil.com', phone: '+351 211 121 314' },
  { name: 'Fine Spice Traders', email: 'trade@finespice.com', phone: '+351 211 151 617' },
  { name: 'Metro Wholesale', email: 'b2b@metrowholesale.com', phone: '+351 211 181 920' },
  { name: 'Bakers Supply Co', email: 'orders@bakerssupply.com', phone: '+351 211 212 223' },
  { name: 'Fresh Direct', email: 'hello@freshdirect.com', phone: '+351 211 242 526' },
] as const;

// ── Folders (5) ────────────────────────────────────────────────────────────────
const FOLDERS = ['Breads', 'Viennoiserie', 'Desserts', 'Pastry', 'Cakes'] as const;

// ── Ingredients (16) — priceCents per canonical unit (kg / litre / piece). ───────
type Dim = 'weight' | 'volume' | 'count';
type SeedIngredient = {
  name: string;
  dimension: Dim;
  priceCents: number;
  opening: number;
  used?: number;
  lowStock?: number;
  supplier: string;
  allergens?: { allergen: AllergenSlug; presence: 'contains' | 'may_contain' }[];
};

const INGREDIENTS: SeedIngredient[] = [
  { name: 'Wheat flour', dimension: 'weight', priceCents: 120, opening: 50000, used: 12000, supplier: 'Northwind Flour Mills', allergens: [{ allergen: 'cereals_gluten', presence: 'contains' }] },
  { name: 'Butter', dimension: 'weight', priceCents: 950, opening: 8000, used: 2500, supplier: 'Bercy Dairy Co', allergens: [{ allergen: 'milk', presence: 'contains' }] },
  { name: 'Caster sugar', dimension: 'weight', priceCents: 110, opening: 25000, used: 4000, supplier: 'Sweet & Salt Supplies' },
  { name: 'Dark chocolate 70%', dimension: 'weight', priceCents: 1800, opening: 6000, used: 1500, supplier: 'Cocoa Barry Depot', allergens: [{ allergen: 'soybeans', presence: 'contains' }, { allergen: 'milk', presence: 'may_contain' }, { allergen: 'nuts', presence: 'may_contain' }] },
  { name: 'Eggs', dimension: 'count', priceCents: 35, opening: 240, used: 60, supplier: 'Valley Farm Eggs', allergens: [{ allergen: 'eggs', presence: 'contains' }] },
  { name: 'Whole milk', dimension: 'volume', priceCents: 150, opening: 20000, used: 3000, supplier: 'Bercy Dairy Co', allergens: [{ allergen: 'milk', presence: 'contains' }] },
  { name: 'Olive oil', dimension: 'volume', priceCents: 900, opening: 5000, used: 800, supplier: 'Olea Oil Imports' },
  { name: 'Fine salt', dimension: 'weight', priceCents: 80, opening: 3000, used: 400, lowStock: 1000, supplier: 'Sweet & Salt Supplies' },
  { name: 'Fresh yeast', dimension: 'weight', priceCents: 1600, opening: 1200, used: 600, lowStock: 1000, supplier: 'Northwind Flour Mills' },
  { name: 'Vanilla extract', dimension: 'volume', priceCents: 12000, opening: 400, used: 120, lowStock: 200, supplier: 'Fine Spice Traders' },
  { name: 'Almond flour', dimension: 'weight', priceCents: 1400, opening: 4000, used: 900, supplier: 'Cocoa Barry Depot', allergens: [{ allergen: 'nuts', presence: 'contains' }] },
  { name: 'Heavy cream', dimension: 'volume', priceCents: 380, opening: 6000, used: 1800, supplier: 'Bercy Dairy Co', allergens: [{ allergen: 'milk', presence: 'contains' }] },
  { name: 'Hazelnuts', dimension: 'weight', priceCents: 2200, opening: 3000, used: 700, supplier: 'Fine Spice Traders', allergens: [{ allergen: 'nuts', presence: 'contains' }] },
  { name: 'Baking powder', dimension: 'weight', priceCents: 600, opening: 1500, used: 300, lowStock: 400, supplier: 'Sweet & Salt Supplies' },
  { name: 'Lemon', dimension: 'count', priceCents: 45, opening: 150, used: 40, supplier: 'Valley Farm Eggs' },
  { name: 'Ground cinnamon', dimension: 'weight', priceCents: 3000, opening: 800, used: 150, lowStock: 200, supplier: 'Fine Spice Traders' },
];

// ── Recipes (20) — all PRICED so margins/food-cost compute. ─────────────────────
type SeedRecipe = {
  name: string;
  folder: (typeof FOLDERS)[number];
  yieldPortions: number;
  sellingPriceCents: number;
  laborCostCents?: number;
  energyCostCents?: number;
  packagingCostCents?: number;
  lines: { ingredient: string; quantity: number }[];
};

const RECIPES: SeedRecipe[] = [
  { name: 'Sourdough loaf', folder: 'Breads', yieldPortions: 4, sellingPriceCents: 450, energyCostCents: 60, lines: [{ ingredient: 'Wheat flour', quantity: 1800 }, { ingredient: 'Fine salt', quantity: 36 }, { ingredient: 'Fresh yeast', quantity: 18 }, { ingredient: 'Whole milk', quantity: 200 }] },
  { name: 'Rosemary focaccia', folder: 'Breads', yieldPortions: 8, sellingPriceCents: 320, energyCostCents: 150, lines: [{ ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Olive oil', quantity: 120 }, { ingredient: 'Fine salt', quantity: 24 }, { ingredient: 'Fresh yeast', quantity: 16 }] },
  { name: 'Baguette', folder: 'Breads', yieldPortions: 6, sellingPriceCents: 220, energyCostCents: 80, lines: [{ ingredient: 'Wheat flour', quantity: 900 }, { ingredient: 'Fine salt', quantity: 18 }, { ingredient: 'Fresh yeast', quantity: 12 }] },
  { name: 'Ciabatta', folder: 'Breads', yieldPortions: 6, sellingPriceCents: 260, energyCostCents: 80, lines: [{ ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Olive oil', quantity: 60 }, { ingredient: 'Fine salt', quantity: 20 }, { ingredient: 'Fresh yeast', quantity: 14 }] },
  { name: 'Brioche', folder: 'Viennoiserie', yieldPortions: 10, sellingPriceCents: 380, laborCostCents: 250, energyCostCents: 80, lines: [{ ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Butter', quantity: 300 }, { ingredient: 'Eggs', quantity: 5 }, { ingredient: 'Whole milk', quantity: 250 }, { ingredient: 'Caster sugar', quantity: 120 }, { ingredient: 'Fresh yeast', quantity: 20 }, { ingredient: 'Fine salt', quantity: 14 }] },
  { name: 'Butter croissant', folder: 'Viennoiserie', yieldPortions: 12, sellingPriceCents: 250, laborCostCents: 200, packagingCostCents: 60, lines: [{ ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Butter', quantity: 500 }, { ingredient: 'Caster sugar', quantity: 100 }, { ingredient: 'Eggs', quantity: 2 }, { ingredient: 'Fine salt', quantity: 12 }, { ingredient: 'Fresh yeast', quantity: 20 }] },
  { name: 'Almond croissant', folder: 'Viennoiserie', yieldPortions: 12, sellingPriceCents: 350, laborCostCents: 300, packagingCostCents: 60, lines: [{ ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Butter', quantity: 500 }, { ingredient: 'Almond flour', quantity: 300 }, { ingredient: 'Caster sugar', quantity: 200 }, { ingredient: 'Eggs', quantity: 3 }, { ingredient: 'Fresh yeast', quantity: 20 }] },
  { name: 'Pain au chocolat', folder: 'Viennoiserie', yieldPortions: 12, sellingPriceCents: 300, laborCostCents: 250, packagingCostCents: 60, lines: [{ ingredient: 'Wheat flour', quantity: 1000 }, { ingredient: 'Butter', quantity: 500 }, { ingredient: 'Dark chocolate 70%', quantity: 360 }, { ingredient: 'Caster sugar', quantity: 100 }, { ingredient: 'Fresh yeast', quantity: 20 }, { ingredient: 'Fine salt', quantity: 12 }] },
  { name: 'Cinnamon rolls', folder: 'Viennoiserie', yieldPortions: 10, sellingPriceCents: 330, laborCostCents: 220, packagingCostCents: 50, lines: [{ ingredient: 'Wheat flour', quantity: 900 }, { ingredient: 'Butter', quantity: 250 }, { ingredient: 'Caster sugar', quantity: 200 }, { ingredient: 'Ground cinnamon', quantity: 30 }, { ingredient: 'Eggs', quantity: 2 }, { ingredient: 'Fresh yeast', quantity: 18 }] },
  { name: 'Chocolate fondant', folder: 'Desserts', yieldPortions: 8, sellingPriceCents: 500, laborCostCents: 800, energyCostCents: 200, packagingCostCents: 120, lines: [{ ingredient: 'Wheat flour', quantity: 200 }, { ingredient: 'Butter', quantity: 300 }, { ingredient: 'Caster sugar', quantity: 250 }, { ingredient: 'Dark chocolate 70%', quantity: 350 }, { ingredient: 'Eggs', quantity: 6 }] },
  { name: 'Crème brûlée', folder: 'Desserts', yieldPortions: 6, sellingPriceCents: 480, laborCostCents: 400, energyCostCents: 150, lines: [{ ingredient: 'Heavy cream', quantity: 500 }, { ingredient: 'Whole milk', quantity: 200 }, { ingredient: 'Eggs', quantity: 6 }, { ingredient: 'Caster sugar', quantity: 150 }, { ingredient: 'Vanilla extract', quantity: 10 }] },
  { name: 'Tiramisu', folder: 'Desserts', yieldPortions: 8, sellingPriceCents: 520, laborCostCents: 500, energyCostCents: 60, lines: [{ ingredient: 'Heavy cream', quantity: 400 }, { ingredient: 'Eggs', quantity: 4 }, { ingredient: 'Caster sugar', quantity: 180 }, { ingredient: 'Dark chocolate 70%', quantity: 80 }] },
  { name: 'Vanilla custard tart', folder: 'Pastry', yieldPortions: 8, sellingPriceCents: 480, laborCostCents: 600, energyCostCents: 150, lines: [{ ingredient: 'Wheat flour', quantity: 300 }, { ingredient: 'Butter', quantity: 200 }, { ingredient: 'Caster sugar', quantity: 200 }, { ingredient: 'Whole milk', quantity: 500 }, { ingredient: 'Eggs', quantity: 4 }, { ingredient: 'Vanilla extract', quantity: 10 }] },
  { name: 'Lemon tart', folder: 'Pastry', yieldPortions: 8, sellingPriceCents: 460, laborCostCents: 500, energyCostCents: 120, lines: [{ ingredient: 'Wheat flour', quantity: 300 }, { ingredient: 'Butter', quantity: 220 }, { ingredient: 'Caster sugar', quantity: 220 }, { ingredient: 'Eggs', quantity: 4 }, { ingredient: 'Lemon', quantity: 4 }] },
  { name: 'Éclair', folder: 'Pastry', yieldPortions: 12, sellingPriceCents: 300, laborCostCents: 450, energyCostCents: 100, packagingCostCents: 40, lines: [{ ingredient: 'Wheat flour', quantity: 250 }, { ingredient: 'Butter', quantity: 200 }, { ingredient: 'Eggs', quantity: 5 }, { ingredient: 'Whole milk', quantity: 300 }, { ingredient: 'Dark chocolate 70%', quantity: 120 }] },
  { name: 'Madeleines', folder: 'Pastry', yieldPortions: 24, sellingPriceCents: 160, laborCostCents: 180, packagingCostCents: 40, lines: [{ ingredient: 'Wheat flour', quantity: 400 }, { ingredient: 'Butter', quantity: 250 }, { ingredient: 'Caster sugar', quantity: 250 }, { ingredient: 'Eggs', quantity: 4 }, { ingredient: 'Baking powder', quantity: 12 }, { ingredient: 'Lemon', quantity: 2 }] },
  { name: 'Chocolate chip cookies', folder: 'Pastry', yieldPortions: 24, sellingPriceCents: 150, laborCostCents: 150, packagingCostCents: 40, lines: [{ ingredient: 'Wheat flour', quantity: 500 }, { ingredient: 'Butter', quantity: 250 }, { ingredient: 'Caster sugar', quantity: 300 }, { ingredient: 'Dark chocolate 70%', quantity: 300 }, { ingredient: 'Eggs', quantity: 2 }] },
  { name: 'Hazelnut praline cake', folder: 'Cakes', yieldPortions: 12, sellingPriceCents: 620, laborCostCents: 900, energyCostCents: 200, packagingCostCents: 150, lines: [{ ingredient: 'Wheat flour', quantity: 400 }, { ingredient: 'Butter', quantity: 300 }, { ingredient: 'Caster sugar', quantity: 300 }, { ingredient: 'Eggs', quantity: 6 }, { ingredient: 'Hazelnuts', quantity: 250 }, { ingredient: 'Dark chocolate 70%', quantity: 150 }] },
  { name: 'Vanilla cheesecake', folder: 'Cakes', yieldPortions: 12, sellingPriceCents: 560, laborCostCents: 700, energyCostCents: 220, packagingCostCents: 120, lines: [{ ingredient: 'Wheat flour', quantity: 250 }, { ingredient: 'Butter', quantity: 180 }, { ingredient: 'Heavy cream', quantity: 500 }, { ingredient: 'Caster sugar', quantity: 250 }, { ingredient: 'Eggs', quantity: 5 }, { ingredient: 'Vanilla extract', quantity: 12 }] },
  { name: 'Carrot & walnut cake', folder: 'Cakes', yieldPortions: 12, sellingPriceCents: 540, laborCostCents: 650, energyCostCents: 200, packagingCostCents: 120, lines: [{ ingredient: 'Wheat flour', quantity: 400 }, { ingredient: 'Caster sugar', quantity: 300 }, { ingredient: 'Olive oil', quantity: 200 }, { ingredient: 'Eggs', quantity: 5 }, { ingredient: 'Hazelnuts', quantity: 150 }, { ingredient: 'Ground cinnamon', quantity: 15 }] },
];

// ── Customers (12) ───────────────────────────────────────────────────────────────
const CUSTOMERS = [
  { name: 'Café Aurora', taxId: 'PT501234567', address: 'Rua das Flores 12, Lisboa', email: 'billing@cafeaurora.pt' },
  { name: 'The Corner Bistro', taxId: 'PT502345678', address: 'Av. da Liberdade 88, Lisboa', email: 'accounts@cornerbistro.pt' },
  { name: 'Grand Hotel Estrela', taxId: 'PT503456789', address: 'Praça do Comércio 3, Lisboa', email: 'purchasing@grandestrela.pt' },
  { name: 'Marina Seafood Co', taxId: 'PT504567890', address: 'Doca de Alcântara, Lisboa', email: 'orders@marinaseafood.pt' },
  { name: 'Bloom Coffee House', taxId: 'PT505678901', address: 'Rua Garrett 45, Lisboa', email: 'hello@bloomcoffee.pt' },
  { name: 'Sunrise Catering', taxId: 'PT506789012', address: 'Estrada de Benfica 200, Lisboa', email: 'events@sunrisecatering.pt' },
  { name: 'Riverside Restaurant', taxId: 'PT507890123', address: 'Cais do Sodré 7, Lisboa', email: 'finance@riverside.pt' },
  { name: 'Olive & Thyme', taxId: 'PT508901234', address: 'Rua do Ouro 120, Lisboa', email: 'admin@oliveandthyme.pt' },
  { name: 'The Daily Grind', taxId: 'PT509012345', address: 'Av. Almirante Reis 33, Lisboa', email: 'ap@dailygrind.pt' },
  { name: 'Harbour Lights Hotel', taxId: 'PT510123456', address: 'Belém Riverside, Lisboa', email: 'procurement@harbourlights.pt' },
  { name: 'Green Fork Deli', taxId: 'PT511234567', address: 'Rua da Prata 60, Lisboa', email: 'orders@greenfork.pt' },
  { name: 'Metropolitan Club', taxId: 'PT512345678', address: 'Chiado 15, Lisboa', email: 'billing@metroclub.pt' },
];

// ── Employees (10) ───────────────────────────────────────────────────────────────
const EMPLOYEES = [
  { name: 'Sofia Almeida', email: 'sofia@prepprofit-demo.com', hourlyRateCents: 1450 },
  { name: 'Miguel Costa', email: 'miguel@prepprofit-demo.com', hourlyRateCents: 1600 },
  { name: 'Beatriz Santos', email: 'beatriz@prepprofit-demo.com', hourlyRateCents: 1350 },
  { name: 'João Ferreira', email: 'joao@prepprofit-demo.com', hourlyRateCents: 1800 },
  { name: 'Carolina Nunes', email: 'carolina@prepprofit-demo.com', hourlyRateCents: 1500 },
  { name: 'André Rocha', email: 'andre@prepprofit-demo.com', hourlyRateCents: 1250 },
  { name: 'Mariana Pinto', email: 'mariana@prepprofit-demo.com', hourlyRateCents: 1700 },
  { name: 'Rui Marques', email: 'rui@prepprofit-demo.com', hourlyRateCents: 1400 },
  { name: 'Inês Lopes', email: 'ines@prepprofit-demo.com', hourlyRateCents: 1300 },
  { name: 'Tomás Silva', email: 'tomas@prepprofit-demo.com', hourlyRateCents: 1550 },
];

// ── Menus (10) — each combines priced recipes. ───────────────────────────────────
const MENUS: { name: string; sellingPriceCents: number; notes: string | null; items: { recipe: string; quantity: number }[] }[] = [
  { name: 'Breakfast Box', sellingPriceCents: 1200, notes: 'Grab-and-go morning set', items: [{ recipe: 'Butter croissant', quantity: 2 }, { recipe: 'Pain au chocolat', quantity: 1 }, { recipe: 'Sourdough loaf', quantity: 1 }] },
  { name: 'Coffee & Pastry', sellingPriceCents: 650, notes: null, items: [{ recipe: 'Almond croissant', quantity: 1 }, { recipe: 'Madeleines', quantity: 2 }] },
  { name: 'Afternoon Tea', sellingPriceCents: 1800, notes: 'Serves two', items: [{ recipe: 'Éclair', quantity: 2 }, { recipe: 'Lemon tart', quantity: 1 }, { recipe: 'Madeleines', quantity: 4 }] },
  { name: 'Dessert Trio', sellingPriceCents: 1500, notes: null, items: [{ recipe: 'Chocolate fondant', quantity: 1 }, { recipe: 'Crème brûlée', quantity: 1 }, { recipe: 'Tiramisu', quantity: 1 }] },
  { name: 'Bread Basket', sellingPriceCents: 900, notes: 'House selection', items: [{ recipe: 'Baguette', quantity: 1 }, { recipe: 'Ciabatta', quantity: 1 }, { recipe: 'Rosemary focaccia', quantity: 1 }] },
  { name: 'Celebration Cake Set', sellingPriceCents: 3200, notes: 'Whole cakes', items: [{ recipe: 'Hazelnut praline cake', quantity: 1 }, { recipe: 'Vanilla cheesecake', quantity: 1 }] },
  { name: 'Weekend Brunch', sellingPriceCents: 2100, notes: null, items: [{ recipe: 'Brioche', quantity: 1 }, { recipe: 'Cinnamon rolls', quantity: 2 }, { recipe: 'Crème brûlée', quantity: 1 }] },
  { name: "Kids' Treat", sellingPriceCents: 550, notes: null, items: [{ recipe: 'Chocolate chip cookies', quantity: 3 }, { recipe: 'Madeleines', quantity: 2 }] },
  { name: 'Catering Platter', sellingPriceCents: 4500, notes: 'Event platter, serves 10', items: [{ recipe: 'Butter croissant', quantity: 6 }, { recipe: 'Pain au chocolat', quantity: 6 }, { recipe: 'Lemon tart', quantity: 2 }, { recipe: 'Chocolate chip cookies', quantity: 12 }] },
  { name: 'Vegan-friendly Box', sellingPriceCents: 1400, notes: 'Selected items', items: [{ recipe: 'Rosemary focaccia', quantity: 1 }, { recipe: 'Carrot & walnut cake', quantity: 1 }] },
];

// ── Task lists (8) with tasks ────────────────────────────────────────────────────
const TASK_LISTS: { name: string; notes: string | null; station: string | null; tasks: { title: string; done?: boolean }[] }[] = [
  { name: 'Morning prep', notes: 'Before service', station: 'pastry', tasks: [{ title: 'Laminate croissant dough', done: true }, { title: 'Proof brioche', done: true }, { title: 'Bake baguettes', done: true }, { title: 'Fill éclairs' }, { title: 'Set up display case' }] },
  { name: 'Opening checklist', notes: null, station: 'front', tasks: [{ title: 'Turn on ovens', done: true }, { title: 'Check fridge temperatures', done: true }, { title: 'Restock napkins & bags' }, { title: 'Count float' }] },
  { name: 'Closing checklist', notes: null, station: 'front', tasks: [{ title: 'Wipe down counters' }, { title: 'Store leftovers' }, { title: 'Empty tills' }, { title: 'Lock back door' }] },
  { name: 'Weekly deep clean', notes: 'Every Sunday', station: 'kitchen', tasks: [{ title: 'Descale espresso machine' }, { title: 'Clean oven racks' }, { title: 'Sanitise mixers' }, { title: 'Mop cold room' }] },
  { name: 'Cake orders — Saturday', notes: 'Pickup 3pm', station: 'pastry', tasks: [{ title: 'Bake hazelnut praline cake', done: true }, { title: 'Decorate cheesecake' }, { title: 'Box and label orders' }] },
  { name: 'Inventory count', notes: 'Month end', station: 'kitchen', tasks: [{ title: 'Count dry goods' }, { title: 'Weigh chocolate stock' }, { title: 'Log low-stock items' }] },
  { name: 'New hire onboarding', notes: null, station: null, tasks: [{ title: 'Hygiene training', done: true }, { title: 'POS walkthrough' }, { title: 'Assign locker' }] },
  { name: 'Supplier deliveries', notes: null, station: 'kitchen', tasks: [{ title: 'Receive flour order', done: true }, { title: 'Check dairy delivery' }, { title: 'Report short deliveries' }] },
];

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (put it in .env.local or the environment).');
  }
  if (!ORG) {
    throw new Error('Set SEED_ORG=<clerk org id> (or pass it as the first argument).');
  }

  console.log(`▶ FULL demo seed for org ${ORG} (wipe + rebuild, atomic)…`);

  await withOrg(ORG, async (tx: TenantTx) => {
    // ── 1. Teardown (children → parents; restrict FKs cleared first) ──────────
    // Order matters: receipts→purchase_orders, receipt_items/stock_count_items/
    // tasks→ingredients&recipes, supplier_invoice_imports→suppliers are all
    // ON DELETE restrict, so the referencing rows go first.
    await tx.delete(transactions).where(eq(transactions.organizationId, ORG));
    await tx.delete(receiptItems).where(eq(receiptItems.organizationId, ORG));
    await tx.delete(receipts).where(eq(receipts.organizationId, ORG));
    await tx.delete(saleItems).where(eq(saleItems.organizationId, ORG));
    await tx.delete(sales).where(eq(sales.organizationId, ORG));
    await tx.delete(invoiceItems).where(eq(invoiceItems.organizationId, ORG));
    await tx.delete(invoices).where(eq(invoices.organizationId, ORG));
    await tx.delete(customers).where(eq(customers.organizationId, ORG));
    await tx.delete(menuItems).where(eq(menuItems.organizationId, ORG));
    await tx.delete(menus).where(eq(menus.organizationId, ORG));
    await tx.delete(productionItems).where(eq(productionItems.organizationId, ORG));
    await tx.delete(productions).where(eq(productions.organizationId, ORG));
    await tx.delete(purchaseOrderItems).where(eq(purchaseOrderItems.organizationId, ORG));
    await tx.delete(purchaseOrders).where(eq(purchaseOrders.organizationId, ORG));
    await tx.delete(supplierInvoiceImportLines).where(eq(supplierInvoiceImportLines.organizationId, ORG));
    await tx.delete(supplierInvoiceImports).where(eq(supplierInvoiceImports.organizationId, ORG));
    await tx.delete(stockCountItems).where(eq(stockCountItems.organizationId, ORG));
    await tx.delete(stockCounts).where(eq(stockCounts.organizationId, ORG));
    await tx.delete(tasks).where(eq(tasks.organizationId, ORG));
    await tx.delete(taskLists).where(eq(taskLists.organizationId, ORG));
    await tx.delete(shifts).where(eq(shifts.organizationId, ORG));
    await tx.delete(employees).where(eq(employees.organizationId, ORG));
    await tx.delete(profitInsights).where(eq(profitInsights.organizationId, ORG));
    await tx.delete(recipeAllergenOverrides).where(eq(recipeAllergenOverrides.organizationId, ORG));
    await tx.delete(ingredientAllergens).where(eq(ingredientAllergens.organizationId, ORG));
    await tx.delete(ingredientSuppliers).where(eq(ingredientSuppliers.organizationId, ORG));
    await tx.delete(ingredientPriceHistory).where(eq(ingredientPriceHistory.organizationId, ORG));
    await tx.delete(recipePresets).where(eq(recipePresets.organizationId, ORG));
    await tx.delete(recipeIngredients).where(eq(recipeIngredients.organizationId, ORG));
    await tx.delete(recipes).where(eq(recipes.organizationId, ORG));
    await tx.delete(ingredients).where(eq(ingredients.organizationId, ORG)); // cascades inventory_movements
    await tx.delete(suppliers).where(eq(suppliers.organizationId, ORG));
    await tx.delete(recipeFolders).where(eq(recipeFolders.organizationId, ORG));
    console.log('  ✓ wiped existing org data');

    // ── 2. Storage areas ──────────────────────────────────────────────────────
    await ensureDefaultArea(tx, ORG);
    for (const name of ['Walk-in fridge', 'Freezer', 'Dry store']) {
      await createArea(tx, ORG, name);
    }

    // ── 3. Suppliers ────────────────────────────────────────────────────────────
    for (const s of SUPPLIERS) {
      const res = await createSupplier(tx, ORG, {
        name: s.name,
        email: s.email,
        phone: s.phone,
        address: null,
        taxId: null,
        notes: null,
      });
      if (res.status !== 'ok') throw new Error(`supplier ${s.name}: ${res.status}`);
    }

    // ── 4. Folders ────────────────────────────────────────────────────────────
    const folderRows = await tx
      .insert(recipeFolders)
      .values(FOLDERS.map((name, i) => ({ organizationId: ORG, name, sortOrder: i })))
      .returning();
    const folderIdByName = new Map(folderRows.map((f) => [f.name, f.id]));

    // ── 5. Ingredients + inventory ledger ──────────────────────────────────────
    const ingRows = await tx
      .insert(ingredients)
      .values(
        INGREDIENTS.map((i) => ({
          organizationId: ORG,
          name: i.name,
          dimension: i.dimension,
          priceCents: i.priceCents,
          stockQuantity: '0',
          lowStockThreshold: i.lowStock != null ? i.lowStock.toString() : null,
        })),
      )
      .returning();
    const ingIdByName = new Map(ingRows.map((i) => [i.name, i.id]));

    let movementCount = 0;
    for (const i of INGREDIENTS) {
      const id = ingIdByName.get(i.name)!;
      await recordMovement(tx, ORG, {
        ingredientId: id,
        deltaCanonical: i.opening,
        note: 'Opening stock',
        source: { type: 'seed' },
        idempotencyKey: `seed:${id}:opening`,
      });
      movementCount++;
      if (i.used) {
        await recordMovement(tx, ORG, {
          ingredientId: id,
          deltaCanonical: -i.used,
          note: 'Production usage',
          source: { type: 'seed' },
          idempotencyKey: `seed:${id}:usage`,
        });
        movementCount++;
      }
    }

    // ── 6. Allergens on ingredients ─────────────────────────────────────────────
    for (const i of INGREDIENTS) {
      if (!i.allergens?.length) continue;
      await replaceIngredientAllergens(
        tx,
        ORG,
        ingIdByName.get(i.name)!,
        i.allergens,
        'seed',
      );
    }

    // ── 7. Default supplier links (populates ingredient_suppliers + price history)
    const packUnitFor: Record<Dim, 'kg' | 'l' | 'count'> = {
      weight: 'kg',
      volume: 'l',
      count: 'count',
    };
    const packSizeFor: Record<Dim, number> = { weight: 25, volume: 10, count: 30 };
    for (const i of INGREDIENTS) {
      const size = packSizeFor[i.dimension];
      const res = await setDefaultSupplier(tx, ORG, ingIdByName.get(i.name)!, {
        supplierName: i.supplier,
        packSize: size,
        packUnit: packUnitFor[i.dimension],
        // Whole-pack price in cents: per-canonical-unit price × pack size.
        packPriceCents: i.priceCents * size,
      });
      if (res.status !== 'ok') throw new Error(`link ${i.name}→${i.supplier}: ${res.status}`);
    }

    // ── 8. Recipes + lines ──────────────────────────────────────────────────────
    const recipeIdByName = new Map<string, string>();
    for (const r of RECIPES) {
      const [recipe] = await tx
        .insert(recipes)
        .values({
          organizationId: ORG,
          name: r.name,
          folderId: folderIdByName.get(r.folder) ?? null,
          yieldPortions: r.yieldPortions,
          yieldPercentage: 100,
          laborCostCents: r.laborCostCents ?? 0,
          energyCostCents: r.energyCostCents ?? 0,
          packagingCostCents: r.packagingCostCents ?? 0,
          sellingPriceCents: r.sellingPriceCents,
        })
        .returning();
      if (!recipe) throw new Error(`recipe ${r.name}`);
      recipeIdByName.set(r.name, recipe.id);
      await tx.insert(recipeIngredients).values(
        r.lines.map((line, index) => ({
          organizationId: ORG,
          recipeId: recipe.id,
          ingredientId: ingIdByName.get(line.ingredient)!,
          quantity: line.quantity.toString(),
          sortOrder: index,
        })),
      );
    }

    // ── 9. Recipe presets (batch targets) ───────────────────────────────────────
    const PRESETS: { recipe: string; name: string; grams: number }[] = [
      { recipe: 'Sourdough loaf', name: 'Large batch', grams: 4000 },
      { recipe: 'Baguette', name: 'Market day', grams: 5400 },
      { recipe: 'Chocolate chip cookies', name: 'Party tray', grams: 3000 },
    ];
    for (const [i, p] of PRESETS.entries()) {
      await tx.insert(recipePresets).values({
        organizationId: ORG,
        recipeId: recipeIdByName.get(p.recipe)!,
        name: p.name,
        targetWeightGrams: p.grams,
        sortOrder: i,
      });
    }

    // ── 10. Categories + 12 months of transactions ──────────────────────────────
    await ensureCategoriesSeeded(tx, ORG);
    const categoryIdBySlug = new Map(
      (await listCategories(tx, ORG)).map((c) => [c.slug, c.id]),
    );
    const incomeRecipes = ['Sourdough loaf', 'Butter croissant', 'Chocolate fondant', 'Almond croissant', 'Crème brûlée', 'Hazelnut praline cake'];
    let txnCount = 0;
    const now = new Date();
    for (let back = 11; back >= 0; back--) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const ym = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      const wobble = 1 + 0.18 * Math.sin((d.getMonth() / 12) * Math.PI * 2);
      const add = async (
        type: 'income' | 'expense',
        slug: string,
        day: string,
        amountCents: number,
        recipe?: string,
        note?: string,
      ) => {
        await tx.insert(transactions).values({
          organizationId: ORG,
          type,
          categoryId: categoryIdBySlug.get(slug)!,
          recipeId: recipe ? recipeIdByName.get(recipe)! : null,
          occurredOn: `${ym}-${day}`,
          amountCents,
          note: note ?? null,
        });
        txnCount++;
      };
      await add('income', 'food_sales', '06', Math.round(52_000 * wobble), incomeRecipes[back % incomeRecipes.length]);
      await add('income', 'food_sales', '14', Math.round(38_000 * wobble), incomeRecipes[(back + 2) % incomeRecipes.length]);
      await add('income', 'catering', '19', Math.round(60_000 * wobble), undefined, 'Event order');
      await add('income', 'beverage_sales', '24', Math.round(18_000 * wobble));
      await add('expense', 'ingredients', '03', Math.round(42_000 * wobble));
      await add('expense', 'rent', '01', 120_000);
      await add('expense', 'staff_wages', '28', 88_000);
      await add('expense', 'utilities', '21', Math.round(15_000 * wobble));
    }
    const thisYm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    for (const [slug, day, amount, note] of [
      ['equipment', '10', 35_000, 'New mixer'],
      ['marketing', '12', 12_000, 'Local ads'],
      ['packaging', '08', 9_000, null],
    ] as const) {
      await tx.insert(transactions).values({
        organizationId: ORG,
        type: 'expense',
        categoryId: categoryIdBySlug.get(slug)!,
        occurredOn: `${thisYm}-${day}`,
        amountCents: amount,
        note,
      });
      txnCount++;
    }

    // ── 11. Customers ─────────────────────────────────────────────────────────────
    const customerIds: string[] = [];
    for (const c of CUSTOMERS) {
      const row = await createCustomer(tx, ORG, c);
      customerIds.push(row.id);
    }

    // ── 12. Invoices (draft / issued / paid) ────────────────────────────────────
    // Reference priced recipes as line descriptions; realistic wholesale volumes.
    const invoiceRecipes = ['Butter croissant', 'Sourdough loaf', 'Pain au chocolat', 'Lemon tart', 'Chocolate chip cookies', 'Baguette'];
    let draftCount = 0, issuedCount = 0, paidCount = 0;
    for (let i = 0; i < 14; i++) {
      const customerId = customerIds[i % customerIds.length]!;
      const lineCount = 2 + (i % 3);
      const items = Array.from({ length: lineCount }, (_, k) => {
        const name = invoiceRecipes[(i + k) % invoiceRecipes.length]!;
        const price = RECIPES.find((r) => r.name === name)!.sellingPriceCents;
        return {
          description: `${name} (wholesale)`,
          quantity: 10 + ((i + k) % 5) * 6,
          unitPriceCents: price,
          taxRate: 23,
        };
      });
      const draft = await createDraftInvoice(tx, ORG, {
        customerId,
        notes: i % 4 === 0 ? 'Monthly wholesale order' : null,
        items,
      });
      // 4 stay draft, 5 issued (open → accounts receivable), 5 paid.
      if (i < 4) {
        draftCount++;
        continue;
      }
      const issuedOn = daysAgo(60 - i * 3);
      const issued = await issueInvoice(tx, ORG, draft.id, ymd(daysFromNow(0)), issuedOn);
      if (issued.status !== 'ok') throw new Error(`issue invoice ${i}: ${issued.status}`);
      if (i >= 9) {
        const paid = await markInvoicePaid(tx, ORG, draft.id, daysAgo(50 - i * 3));
        if (paid !== 'ok') throw new Error(`pay invoice ${i}: ${paid}`);
        paidCount++;
      } else {
        issuedCount++;
      }
    }

    // ── 13. Employees + shifts ─────────────────────────────────────────────────
    const employeeIds: string[] = [];
    for (const e of EMPLOYEES) {
      const row = await createEmployee(tx, ORG, e);
      employeeIds.push(row.id);
    }
    let shiftCount = 0;
    for (let i = 0; i < employeeIds.length; i++) {
      // Two recent closed shifts per employee (8h with a 30-min break).
      for (const back of [i + 2, i + 9]) {
        const start = daysAgo(back);
        start.setHours(8, 0, 0, 0);
        const end = new Date(start);
        end.setHours(16, 30, 0, 0);
        await createShift(tx, ORG, {
          employeeId: employeeIds[i]!,
          startedAtMs: start.getTime(),
          endedAtMs: end.getTime(),
          breakMinutes: 30,
          note: null,
        });
        shiftCount++;
      }
    }

    // ── 14. Menus ────────────────────────────────────────────────────────────────
    for (const m of MENUS) {
      const res = await createMenu(
        tx,
        ORG,
        { name: m.name, sellingPriceCents: m.sellingPriceCents, notes: m.notes },
        m.items.map((it) => ({ recipeId: recipeIdByName.get(it.recipe)!, quantity: it.quantity })),
      );
      if (res.status !== 'ok') throw new Error(`menu ${m.name}: ${res.status}`);
    }

    // ── 15. Task lists + tasks (some done) ──────────────────────────────────────
    for (const list of TASK_LISTS) {
      const created = await createTaskList(tx, ORG, {
        name: list.name,
        notes: list.notes,
        scheduledFor: null,
      });
      for (const t of list.tasks) {
        const res = await addTask(tx, ORG, created.id, {
          title: t.title,
          notes: null,
          station: list.station,
          dueOn: null,
        });
        if (res.status !== 'ok') throw new Error(`task "${t.title}": ${res.status}`);
        if (t.done) {
          // Mark done directly (both provenance columns set, per the DB CHECK).
          await tx
            .update(tasks)
            .set({ status: 'done', completedAt: new Date(), completedBy: 'seed' })
            .where(and(eq(tasks.organizationId, ORG), eq(tasks.id, res.task.id)));
        }
      }
    }

    // ── 16. Sales (draft daily closes, distinct dates) ──────────────────────────
    const saleRecipes = ['Butter croissant', 'Sourdough loaf', 'Pain au chocolat', 'Almond croissant', 'Baguette', 'Chocolate chip cookies', 'Madeleines'];
    let saleCount = 0;
    for (let i = 0; i < 12; i++) {
      const saleDate = ymd(daysAgo(i + 1));
      const lineCount = 3 + (i % 3);
      const lines = Array.from({ length: lineCount }, (_, k) => {
        const name = saleRecipes[(i + k) % saleRecipes.length]!;
        const price = RECIPES.find((r) => r.name === name)!.sellingPriceCents;
        return {
          itemKind: 'recipe' as const,
          itemRecipeId: recipeIdByName.get(name)!,
          itemMenuId: null,
          itemIngredientId: null,
          quantity: 5 + ((i + k) % 8),
          ingredientQtyCanonical: null,
          unitNetCents: price,
          taxRateBps: 2300,
        };
      });
      const res = await createSale(tx, ORG, { saleDate, note: `Daily close ${saleDate}` }, lines);
      if (res.status !== 'ok') throw new Error(`sale ${saleDate}: ${res.status}`);
      saleCount++;
    }

    // ── 17. Productions (drafts; a few planned) ─────────────────────────────────
    const prodRecipes = ['Butter croissant', 'Sourdough loaf', 'Baguette', 'Pain au chocolat', 'Brioche', 'Almond croissant', 'Chocolate chip cookies', 'Madeleines', 'Ciabatta', 'Cinnamon rolls'];
    let prodCount = 0, plannedCount = 0;
    for (let i = 0; i < 10; i++) {
      const r1 = prodRecipes[i % prodRecipes.length]!;
      const r2 = prodRecipes[(i + 3) % prodRecipes.length]!;
      const items = [
        { recipeId: recipeIdByName.get(r1)!, plannedQty: 12 + i * 2 },
        ...(r2 !== r1 ? [{ recipeId: recipeIdByName.get(r2)!, plannedQty: 6 + i }] : []),
      ];
      const res = await createProduction(
        tx,
        ORG,
        { reference: `Bake run #${100 + i}`, notes: null, plannedFor: ymd(daysFromNow(i % 5)) },
        items,
      );
      if (res.status !== 'ok') throw new Error(`production ${i}: ${res.status}`);
      prodCount++;
      // Plan roughly half so the list shows a mix of draft/planned.
      if (i % 2 === 0) {
        const planned = await planProduction(tx, ORG, res.production.id, res.production.updatedAt);
        if (planned.status === 'ok') plannedCount++;
      }
    }

    // ── 18. Purchase orders (drafts; a few sent) ────────────────────────────────
    const supplierRows = await tx
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(eq(suppliers.organizationId, ORG));
    const supplierIdByName = new Map(supplierRows.map((s) => [s.name, s.id]));
    const poPlan: { supplier: string; items: { ingredient: string; quantity: number }[] }[] = [
      { supplier: 'Northwind Flour Mills', items: [{ ingredient: 'Wheat flour', quantity: 50000 }, { ingredient: 'Fresh yeast', quantity: 2000 }] },
      { supplier: 'Bercy Dairy Co', items: [{ ingredient: 'Butter', quantity: 10000 }, { ingredient: 'Whole milk', quantity: 20000 }, { ingredient: 'Heavy cream', quantity: 8000 }] },
      { supplier: 'Sweet & Salt Supplies', items: [{ ingredient: 'Caster sugar', quantity: 30000 }, { ingredient: 'Fine salt', quantity: 5000 }, { ingredient: 'Baking powder', quantity: 2000 }] },
      { supplier: 'Cocoa Barry Depot', items: [{ ingredient: 'Dark chocolate 70%', quantity: 8000 }, { ingredient: 'Almond flour', quantity: 5000 }] },
      { supplier: 'Valley Farm Eggs', items: [{ ingredient: 'Eggs', quantity: 360 }, { ingredient: 'Lemon', quantity: 120 }] },
      { supplier: 'Olea Oil Imports', items: [{ ingredient: 'Olive oil', quantity: 10000 }] },
      { supplier: 'Fine Spice Traders', items: [{ ingredient: 'Vanilla extract', quantity: 1000 }, { ingredient: 'Hazelnuts', quantity: 4000 }, { ingredient: 'Ground cinnamon', quantity: 1000 }] },
      { supplier: 'Northwind Flour Mills', items: [{ ingredient: 'Wheat flour', quantity: 25000 }] },
      { supplier: 'Bercy Dairy Co', items: [{ ingredient: 'Butter', quantity: 6000 }] },
      { supplier: 'Sweet & Salt Supplies', items: [{ ingredient: 'Caster sugar', quantity: 15000 }] },
    ];
    let poCount = 0, sentCount = 0;
    for (let i = 0; i < poPlan.length; i++) {
      const p = poPlan[i]!;
      const res = await createDraftPurchaseOrder(tx, ORG, {
        supplierId: supplierIdByName.get(p.supplier)!,
        expectedDate: ymd(daysFromNow(3 + (i % 5))),
        notes: null,
        items: p.items.map((it) => ({
          ingredientId: ingIdByName.get(it.ingredient)!,
          quantity: it.quantity,
          unitCostCents: INGREDIENTS.find((x) => x.name === it.ingredient)!.priceCents,
        })),
      });
      if (res.status !== 'ok') throw new Error(`PO ${i}: ${res.status}`);
      poCount++;
      // Send about half so the list shows draft + sent.
      if (i % 2 === 1) {
        const sent = await sendPurchaseOrder(tx, ORG, res.order.id, daysAgo(i));
        if (sent.status === 'ok') sentCount++;
      }
    }

    console.log(
      `  ✓ ${SUPPLIERS.length} suppliers, ${INGREDIENTS.length} ingredients (${movementCount} movements), ${RECIPES.length} recipes, ${txnCount} transactions,\n` +
        `    ${customerIds.length} customers, invoices ${draftCount} draft/${issuedCount} issued/${paidCount} paid,\n` +
        `    ${employeeIds.length} employees (${shiftCount} shifts), ${MENUS.length} menus, ${TASK_LISTS.length} task lists,\n` +
        `    ${saleCount} sales, ${prodCount} productions (${plannedCount} planned), ${poCount} POs (${sentCount} sent)`,
    );
  });

  console.log(`✓ Seeded org ${ORG}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
