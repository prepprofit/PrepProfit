/**
 * Offline generator for the seed ingredient catalogue
 * (docs/ingredient-seed-catalog-plan.md, Slice 2).
 *
 * NEVER runs in CI/build. Run it by hand when refreshing the dataset:
 *
 *   1. Download the USDA FDC "SR Legacy" CSV dump (CC0) from
 *      https://fdc.nal.usda.gov/download-datasets.html
 *      and unzip it somewhere local.
 *   2. npx tsx scripts/generate-ingredient-catalog.ts <path-to-unzipped-dir>
 *   3. Review the git diff of lib/ingredient-catalog/data/catalog.json and
 *      commit it like any data PR. Entry ids are stable slugs — the generator
 *      must never repurpose an id for a different food.
 *
 * The generated base is then merged with the hand-curated overrides file
 * (lib/ingredient-catalog/data/overrides.json): overrides can patch fields
 * (typically allergens/dimension), add extra entries, or remove noise by id.
 * Allergen tags produced here are HEURISTIC "typical" tags — they are seeded
 * as unreviewed and the UI says so; curation happens in overrides.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Presence = 'contains' | 'may_contain';
type AllergenTag = { allergen: string; presence: Presence };
type CatalogEntry = {
  id: string;
  nameEn: string;
  aliases: string[];
  dimension: 'weight' | 'volume' | 'count';
  category: string;
  allergens: AllergenTag[];
  suggestedFdcId: number | null;
};

const srDir = process.argv[2];
if (!srDir || !existsSync(join(srDir, 'food.csv'))) {
  console.error(
    'Usage: npx tsx scripts/generate-ingredient-catalog.ts <sr-legacy-csv-dir>',
  );
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(repoRoot, 'lib', 'ingredient-catalog', 'data');

/** Minimal RFC-4180 CSV parser (SR Legacy uses quoted fields throughout). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

const foodRows = parseCsv(readFileSync(join(srDir, 'food.csv'), 'utf8')).slice(1);
const categoryRows = parseCsv(
  readFileSync(join(srDir, 'food_category.csv'), 'utf8'),
).slice(1);
const categoryById = new Map(categoryRows.map((r) => [r[0], r[2]]));

/** Raw-ingredient categories worth seeding a kitchen with (see plan §2). */
const KEEP_CATEGORIES = new Set([
  '1', // Dairy and Egg Products
  '2', // Spices and Herbs
  '4', // Fats and Oils
  '5', // Poultry Products
  '7', // Sausages and Luncheon Meats
  '9', // Fruits and Fruit Juices
  '10', // Pork Products
  '11', // Vegetables and Vegetable Products
  '12', // Nut and Seed Products
  '13', // Beef Products
  '14', // Beverages
  '15', // Finfish and Shellfish Products
  '16', // Legumes and Legume Products
  '17', // Lamb, Veal, and Game Products
  '18', // Baked Products
  '19', // Sweets
  '20', // Cereal Grains and Pasta
  '28', // Alcoholic Beverages (cooking wine/beer/spirits)
]);

/** Variant/prep descriptors that mark noise, not a distinct pantry item. */
const DROP_PATTERNS: RegExp[] = [
  /separable (lean|fat) only/i,
  /\bcooked\b/i,
  /\bbraised\b/i,
  /\broasted\b/i,
  /\bbroiled\b/i,
  /\bgrilled\b/i,
  /\bbaked\b/i,
  /\bfried\b/i,
  /\bstewed\b/i,
  /\bsimmered\b/i,
  /\bmicrowaved\b/i,
  /\bheated\b/i,
  /\bboiled\b/i,
  /\bdrained\b/i,
  /\breheated\b/i,
  /\brehydrated\b/i,
  /with added/i,
  /\bfortified\b/i,
  /\breduced sodium\b/i,
  /\blower sodium\b/i,
  /\blow sodium\b/i,
  /\bfat free\b/i,
  /\breduced fat\b/i,
  /\blower fat\b/i,
  /\blow fat\b/i,
  /\bnonfat\b/i,
  /\blight\b/i,
  /\blite\b/i,
  /\bhome-prepared\b/i,
  /home recipe/i,
  /\bbabyfood\b/i,
  /\bformula\b/i,
  /industrially prepared/i,
  /\bimitation\b/i,
  /\bsubstitute\b/i,
  /\bretail\b/i,
  /\binstitutional\b/i,
  /USDA Commodity/i,
  /school lunch/i,
  /\bnfs\b/i,
  /\(includes foods for/i,
];

/** All-caps token of 3+ letters ≈ a brand name in SR Legacy descriptions. */
const BRAND_TOKEN = /\b[A-Z][A-Z'&.-]{2,}\b/;

/** Title-case brands that survive the all-caps heuristic (finite, known set). */
const BRAND_NAMES =
  /\b(Andrea's|Archway|George Weston|Glutino|Heinz|Interstate Brands|Keikitos|Kraft|Martha White|Pillsbury|Rudi's|Udi's|Van's|Mission Foods|Continental Mills|Hostess|Pepperidge|Krusteaz|Weight Watcher|Lea & Perrins|Thomas English)\b|refrigerated dough|Latino bakery item/;

function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(s: string): string {
  return normalizeName(s).replace(/ /g, '-');
}

function has(desc: string, re: RegExp): boolean {
  return re.test(desc);
}

const TREE_NUT =
  /\b(almond|walnut|cashew|pistachio|pecan|hazelnut|filbert|macadamia|brazil ?nut|pine nut|pignolia)\b/i;
const CRUSTACEAN = /\b(shrimp|prawn|crab|lobster|crayfish|crawfish)\b/i;
const MOLLUSC =
  /\b(clam|oyster|mussel|scallop|squid|octopus|snail|abalone|cuttlefish|whelk|conch)\b/i;
const GLUTEN_GRAIN =
  /\b(wheat|barley|rye|oat|oats|oatmeal|spelt|kamut|triticale|semolina|couscous|bulgur|farina|seitan|pasta|noodle|macaroni|spaghetti|bread|flour tortilla|cracker|malt)\b/i;
const MILKY = /\b(milk|butter|cheese|yogurt|cream|whey|ghee|kefir|buttermilk|custard)\b/i;
const EGGY = /\begg\b|\beggs\b/i;
const SOY = /\b(soy|soybean|tofu|tempeh|edamame|miso|natto)\b/i;
function allergensFor(desc: string, categoryId: string): AllergenTag[] {
  const tags = new Map<string, Presence>();
  const contains = (a: string) => tags.set(a, 'contains');
  const may = (a: string) => {
    if (tags.get(a) !== 'contains') tags.set(a, 'may_contain');
  };

  if (categoryId === '1') {
    if (EGGY.test(desc)) contains('eggs');
    else contains('milk');
  }
  if (categoryId === '15') {
    if (CRUSTACEAN.test(desc)) contains('crustaceans');
    else if (MOLLUSC.test(desc)) contains('molluscs');
    else contains('fish');
  }
  if (categoryId === '18') {
    contains('cereals_gluten');
    may('eggs');
    may('milk');
    may('soybeans');
  }
  if (categoryId === '20' && GLUTEN_GRAIN.test(desc)) contains('cereals_gluten');
  if (/\b(rice|corn|buckwheat|quinoa|millet|amaranth|sorghum|teff)\b/i.test(desc)) {
    // gluten-free grains: no tag unless a gluten grain keyword also matched above
  }
  if (TREE_NUT.test(desc)) contains('nuts');
  if (/\bpeanut/i.test(desc)) contains('peanuts');
  if (/\bsesame|tahini\b/i.test(desc)) contains('sesame');
  if (SOY.test(desc)) contains('soybeans');
  if (/\blupin/i.test(desc)) contains('lupin');
  if (/\bcelery|celeriac\b/i.test(desc)) contains('celery');
  if (/\bmustard\b/i.test(desc)) contains('mustard');
  if (MILKY.test(desc) && categoryId !== '15') contains('milk');
  if (EGGY.test(desc) && categoryId !== '1' && categoryId !== '18') contains('eggs');
  if (has(desc, GLUTEN_GRAIN) && categoryId !== '20' && categoryId !== '18')
    contains('cereals_gluten');
  if (/\bwine\b|\bvinegar\b|dried.*(apricot|fruit)/i.test(desc)) may('sulphites');
  if (CRUSTACEAN.test(desc) && categoryId !== '15') contains('crustaceans');
  if (MOLLUSC.test(desc) && categoryId !== '15') contains('molluscs');

  const ORDER = [
    'cereals_gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans',
    'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin',
    'molluscs',
  ];
  return [...tags.entries()]
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
    .map(([allergen, presence]) => ({ allergen, presence }));
}

function dimensionFor(desc: string, categoryId: string): CatalogEntry['dimension'] {
  if (/^egg, whole/i.test(desc)) return 'count';
  if (categoryId === '14' || categoryId === '28') return 'volume';
  if (categoryId === '4' && /\boil\b/i.test(desc)) return 'volume';
  if (/\b(fluid|juice|vinegar|extract)\b/i.test(desc)) return 'volume';
  if (categoryId === '1' && /^milk,|^cream,/i.test(desc)) return 'volume';
  return 'weight';
}

const entries = new Map<string, CatalogEntry>();
let kept = 0;
for (const [fdcIdRaw, dataType, description, categoryId] of foodRows) {
  if (dataType !== 'sr_legacy_food') continue;
  if (!description || !categoryId) continue;
  if (!KEEP_CATEGORIES.has(categoryId)) continue;
  if (DROP_PATTERNS.some((re) => re.test(description))) continue;
  if (BRAND_TOKEN.test(description) || BRAND_NAMES.test(description)) continue;

  // Strip pure prep/grade descriptor segments ("raw", "all grades",
  // 'trimmed to 1/8" fat', "separable lean and fat", ...) so whole meat/fish
  // cuts survive as pantry items instead of being counted as variant noise.
  const NOISE_SEGMENT =
    /^(raw|fresh|frozen|all grades|choice|select|prime|untrimmed|boneless|bone-in|skinless|meat only|meat and skin|separable lean and fat|trimmed to.*|farmed|wild|domesticated|year round average|composite of trimmed retail cuts|unprepared|unsweetened|sweetened|solids and liquids|whole|chopped|sliced|diced|ground|dry|dried|unsalted|salted|salt added|no salt added|without salt|with salt|enriched|unenriched|regular|plain|original)$/i;
  const segments = description
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !NOISE_SEGMENT.test(s));
  // >3 remaining comma segments = deep variant noise.
  if (segments.length === 0 || segments.length > 3) continue;
  const name = segments.slice(0, 3).join(', ');
  if (name.length > 60) continue;

  const id = slugify(name);
  if (entries.has(id)) continue; // first (lowest fdc_id) wins
  const fdcId = Number(fdcIdRaw);
  entries.set(id, {
    id,
    nameEn: name,
    aliases: [],
    dimension: dimensionFor(description, categoryId),
    category: categoryById.get(categoryId) ?? 'Other',
    allergens: allergensFor(description, categoryId),
    suggestedFdcId: Number.isFinite(fdcId) ? fdcId : null,
  });
  kept++;
}

// Merge hand-curated overrides: { remove: string[], patch: {...}[], add: {...}[] }
type Overrides = {
  remove?: string[];
  patch?: (Partial<CatalogEntry> & { id: string })[];
  add?: CatalogEntry[];
};
const overridesPath = join(dataDir, 'overrides.json');
const overrides: Overrides = existsSync(overridesPath)
  ? JSON.parse(readFileSync(overridesPath, 'utf8'))
  : {};
for (const id of overrides.remove ?? []) entries.delete(id);
for (const patch of overrides.patch ?? []) {
  const existing = entries.get(patch.id);
  if (existing) entries.set(patch.id, { ...existing, ...patch });
}
for (const add of overrides.add ?? []) entries.set(add.id, add);

const list = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(
  join(dataDir, 'catalog.json'),
  JSON.stringify(list, null, 1) + '\n',
  'utf8',
);
console.log(`kept ${kept} generated, ${list.length} total after overrides`);
const byCat = new Map<string, number>();
for (const e of list) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${c}: ${n}`);
