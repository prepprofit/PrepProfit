# PrepProfit AI Implementation Roadmap - Senior Revised

**Status:** Senior product and engineering revision  
**Date:** 2026-06-29  
**Owner:** Andre Lopes  
**Project:** PrepProfit  
**Reviewed against:** `PrepProfit-main (33).zip`, current repo structure, existing AI photo import, ingredient pricing, suppliers, purchase orders, receipts, sales, menus, tasks, RBAC/RLS, entitlements and product positioning.

---

## 1. Senior review summary

The original plan has the right strategic thesis: PrepProfit should not compete as a generic recipe AI tool. The AI hook should be margin protection for kitchens.

The main revision is sequencing.

Do not start with a standalone "AI foundation" sprint. It is technically tidy, but it delays visible customer value. Build the smallest shared AI foundation only when the first new provider-backed feature needs it. Start with deterministic profit leaks because it produces value from data already in the product and becomes the engine that invoice AI feeds.

The strongest launch story remains:

> Upload a supplier invoice. PrepProfit detects ingredient cost changes, shows which recipes and menu items are now under margin, and tells the manager what to review.

The revised value order is:

1. **Profit Leak Detector MVP, no LLM**
2. **Supplier Invoice Reader MVP, price observations only**
3. **Invoice-to-Profit Impact Loop**
4. **AI Explanations and Profit Insight Inbox**
5. **Menu Engineer**
6. **Daily Close Summary**
7. **Prep/Reorder Planner**
8. **Weekly CFO Report, then chat later**

This order maximizes user value while keeping financial correctness, tenant isolation and implementation risk under control.

---

## 2. What changes from the original plan

### 2.1 Move infrastructure out of first position

The original plan starts with **Phase AI-0 - Shared AI foundation**. The work is valid, but it should not be the first visible sprint.

Revised approach:

- Sprint 1 has no LLM call and no generic AI ledger requirement.
- Sprint 2 introduces the minimal shared provider wrapper, feature quota and `ai_operation_attempts` ledger because Supplier Invoice Reader is the first new provider-backed feature.
- Do not refactor the existing `ai_extraction_attempts` table in the first pass.

### 2.2 Split "invoice reader" from "profit impact"

Invoice extraction alone is useful, but the real customer "aha" is the downstream impact:

```txt
Invoice line changed butter cost
-> pending ingredient cost is raised
-> affected recipes are identified
-> affected menu margins are shown
-> manager accepts or rejects the cost update
```

This should be planned as its own value slice, not hidden inside extraction plumbing.

### 2.3 Use existing pricing model instead of inventing a parallel workflow

The repo already has the right primitives:

- `ingredients.price_cents`
- `ingredients.pending_price_cents`
- `ingredients.needs_pricing`
- `ingredient_price_history`
- `ingredient_price_history.source = 'manual' | 'order' | 'quote' | 'import'`
- manager acceptance flow for pending costs
- purchase receipts that raise pending costs without silently changing approved costs

Supplier invoice AI should create reviewed **price observations** first. It should not directly update approved ingredient prices, inventory, receipts, transactions or menu prices.

### 2.4 Do not add a generic `ai_insights` table too early

Generic insight persistence is attractive, but it can become a vague dumping ground.

For Sprint 1:

- calculate findings on demand;
- use stable finding fingerprints;
- persist dismissals/resolutions only if the UI needs them.

Add a generic `ai_insights` table only after at least two insight features need the same lifecycle.

### 2.5 Target margin source needs a pragmatic MVP decision

The current repo has `MARGIN_THRESHOLDS = { green: 65, yellow: 40 }` in `lib/calculations/margin.ts`. There is no organization-level target margin setting yet.

For MVP:

- use the existing green threshold, 65 percent gross margin, as the default target;
- name this explicitly in the UI as the default target;
- add organization-level `target_margin_bps` later if users need customization.

This avoids a settings migration before the first value sprint.

---

## 3. Repo facts that should drive implementation

### 3.1 Product direction

`PRODUCT.md` positions PrepProfit as a financial tool for small kitchens:

- numbers are the product;
- margins and food cost matter more than generic recipe workflow;
- users are food experts, not finance experts.

AI should make the numbers more actionable, not replace deterministic financial logic.

### 3.2 Existing AI

Current AI is recipe photo extraction.

Important files:

```txt
lib/ai/recipe-extraction.ts
lib/ai/photo-draft.ts
lib/ai/photo-draft-schema.ts
lib/ai/pricing.ts
lib/data/ai-extraction.ts
app/api/recipes/import/photo/route.ts
app/api/recipes/import/photo/stage/route.ts
app/(app)/recipes/import/photo/photo-workbench.tsx
```

Current ledger:

```txt
ai_extraction_attempts
```

It is intentionally specific to recipe photo extraction. Do not rename or generalize it as part of the next sprint.

### 3.3 Ingredient pricing already supports safe AI invoice import

Existing behavior:

- approved cost lives in `ingredients.price_cents`;
- pending observed cost lives in `ingredients.pending_price_cents`;
- missing price is represented by `needs_pricing`;
- price history records observations and acceptance;
- receipts and quotes raise pending price rather than silently mutating approved price.

Supplier Invoice Reader should reuse this exact pattern.

### 3.4 Recipes and menus derive costs live

Recipe cost is calculated from current ingredient prices.

Menus derive cost from component recipe costs and have an incomplete state when a component is unavailable. This is good and should be preserved.

Profit Leak Detector should use the same calculation modules rather than introduce a second cost engine.

### 3.5 Sales data is ready for later menu engineering

Sales support:

- `sales.status = draft | posted | void`
- frozen sale totals on posted sales;
- `sale_items.item_kind = recipe | menu | ingredient`;
- item references and frozen names.

This is enough to build menu engineering later, but only after profit leak and invoice cost freshness are working.

### 3.6 Tasks are ready for future prep/reorder planning

Tasks already support:

```txt
source_kind = manual | prep | reorder
source_recipe_id
source_ingredient_id
```

This is a good landing zone for a future Prep/Reorder Planner, but it should not come before the margin story.

### 3.7 RLS and same-org references are non-negotiable

New business tables must:

- carry `organization_id`;
- be added to `businessTables`;
- use `withOrg`;
- use same-org composite FKs where relational links exist;
- include org isolation tests.

---

## 4. Non-negotiable implementation rules

### 4.1 AI cannot be the source of financial truth

AI may:

- extract text from messy invoices or photos;
- classify model output into a structured draft;
- explain deterministic findings;
- draft summaries;
- suggest actions.

AI must not:

- silently update approved ingredient prices;
- silently change recipe or menu selling prices;
- post sales, transactions, receipts or inventory movements;
- decide margin or food cost from prose;
- make accounting, tax or payroll decisions.

Correct architecture:

```txt
Existing data
-> deterministic calculation module
-> structured finding
-> optional AI explanation
-> human review
-> deterministic write
```

### 4.2 Human review before writes

Use the existing photo import pattern:

```txt
extract
-> editable draft
-> stage
-> confirm
-> write
```

For invoice AI:

```txt
upload invoice
-> extract invoice draft
-> manager reviews lines
-> match supplier and ingredients
-> create price observations
-> manager accepts pending prices
```

### 4.3 Manager-only for financial AI

Manager-only:

- profit leaks;
- price changes;
- invoice cost impact;
- menu engineering;
- daily close financial summaries;
- CFO reports;
- supplier comparisons.

Kitchen-role users may access AI only when the output is money-free, for example prep tasks without prices.

### 4.4 No raw customer content in logs

Do not log:

- invoice text;
- image bytes;
- raw model output;
- recipe prose;
- bank details;
- staff names;
- customer financial details.

Allowed metadata:

```ts
{
  action: 'ai.invoice.extract',
  orgId,
  attemptId,
  provider,
  model,
  lineCount,
  costMicros,
  qualityFlagCount,
  errorCode
}
```

### 4.5 Structured schemas everywhere

Every AI-backed feature needs:

- TypeScript types;
- Zod schema for provider output;
- editable draft schema when user review is required;
- server-side validation before staging;
- server-side validation before final write;
- stable error codes;
- tests for malformed model output.

### 4.6 User-facing text must be localized

The app uses `next-intl`. New UI copy and action errors should go through the existing i18n message pattern, not hard-coded strings.

---

## 5. Value-ordered sprint roadmap

| Value rank | Sprint | User-visible value | Why this order |
|---:|---|---|---|
| 1 | Profit Leak Detector MVP, no LLM | Shows recipes, menus and ingredients hurting margin right now | Uses existing data, low AI risk, highest owner pain |
| 2 | Supplier Invoice Reader MVP | Upload invoice and turn lines into reviewed price observations | Keeps costs fresh, feeds profit leaks |
| 3 | Invoice-to-Profit Impact Loop | Shows which recipes/menus changed after an invoice | This is the strongest demo and commercial hook |
| 4 | AI Explanations and Profit Insight Inbox | Explains deterministic findings in chef-friendly language | Adds AI polish after the math is trusted |
| 5 | Menu Engineer | Classifies items by popularity and profitability | Valuable once cost and sales data are reliable |
| 6 | Daily Close Summary | Explains posted sales and food-cost anomalies | Useful for active operators, depends on sales adoption |
| 7 | Prep/Reorder Planner | Creates prep/reorder suggestions from recipes and stock | Operational value, but more data hygiene dependency |
| 8 | Weekly CFO Report, then chat | Premium management layer over trusted insights | High value, but should wait until insight modules exist |

---

## 6. Sprint 1 - Profit Leak Detector MVP, no LLM

### Goal

Give managers immediate visibility into margin leaks using deterministic calculations only.

### User promise

> PrepProfit shows what is underpriced, unpriced or at margin risk before the owner finds it in a spreadsheet.

### Scope

Detect these MVP findings:

```txt
UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE
UNPRICED_INGREDIENT_IN_ACTIVE_MENU
RECIPE_BELOW_TARGET_MARGIN
MENU_BELOW_TARGET_MARGIN
PENDING_PRICE_CHANGE_IMPACT
```

Use the existing default target:

```txt
target margin = MARGIN_THRESHOLDS.green = 65%
```

Do not add a target-margin settings migration in Sprint 1 unless the product decision is already made.

### Suggested files

```txt
lib/calculations/profit-leaks.ts
lib/calculations/profit-leaks.test.ts
lib/data/profit-leaks.ts
components/app/dashboard/profit-leaks-card.tsx
app/(app)/dashboard/page.tsx
lib/i18n/messages/en.json
```

Optional only if dismissing is in MVP:

```txt
lib/data/profit-leak-dismissals.ts
```

### Finding shape

Use a deterministic, compact shape.

```ts
export type ProfitLeakFinding = {
  fingerprint: string;
  type:
    | 'UNPRICED_INGREDIENT_IN_ACTIVE_RECIPE'
    | 'UNPRICED_INGREDIENT_IN_ACTIVE_MENU'
    | 'RECIPE_BELOW_TARGET_MARGIN'
    | 'MENU_BELOW_TARGET_MARGIN'
    | 'PENDING_PRICE_CHANGE_IMPACT';
  severity: 'info' | 'warning' | 'critical';
  entityType: 'ingredient' | 'recipe' | 'menu';
  entityId: string;
  affectedEntityIds: string[];
  currentMarginPercent: number | null;
  targetMarginPercent: number | null;
  currentCostCents: number | null;
  pendingCostCents: number | null;
  suggestedPriceCents: number | null;
  reasonCode: string;
};
```

Use `fingerprint` rather than a DB id for calculated findings. A fingerprint can be derived from:

```txt
organization id + finding type + entity id + relevant price/cost version
```

If the team later persists findings, the fingerprint becomes the de-duplication key.

### UI

Dashboard card:

```txt
Profit leaks
```

Show:

- count of critical findings;
- count of recipes or menus below target margin;
- count of unpriced ingredients affecting active recipes/menus;
- top 5 findings;
- links to ingredient, recipe or menu pages.

Do not call it "AI" in Sprint 1 unless an AI explanation exists. The value is still strong without an LLM.

### Out of scope

- AI explanations;
- invoice upload;
- sales mix analysis;
- persisted insight inbox;
- automatic price changes;
- automatic menu repricing.

### Acceptance criteria

- Findings are produced without any AI provider call.
- Manager-only gate protects all financial findings.
- Kitchen users cannot access the card or endpoint.
- Missing price produces "needs pricing", not a fake zero-cost margin.
- Incomplete menu cost remains incomplete.
- Pending price changes are shown as pending impact, not active approved cost.
- Every finding links to the source entity.
- No new raw customer content is logged.
- Unit tests cover recipe, menu, missing price, pending price and deleted/trash edge cases.
- Data access is org-scoped through `withOrg`.

### Gate

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

---

## 7. Sprint 2 - Supplier Invoice Reader MVP, price observations only

### Goal

Let a manager upload an invoice and create reviewed ingredient price observations without silently changing approved costs.

### User promise

> Upload a supplier invoice. PrepProfit extracts ingredient prices and asks you what to accept.

### Scope

Build:

- upload route for image/PDF;
- byte, MIME and size validation;
- invoice extraction schema;
- draft workbench;
- supplier matching;
- ingredient matching;
- editable line review;
- stage approved lines as `ingredient_price_history.source = 'import'`;
- update `ingredients.pending_price_cents`;
- do not update `ingredients.price_cents`;
- do not move inventory;
- do not create receipts;
- do not create transactions.

### Why price observations first

The repo already has full PO/receipt logic. Invoice AI should not bypass it.

MVP should answer:

```txt
Did this invoice reveal new ingredient costs?
```

It should not yet answer:

```txt
Did we receive stock against a purchase order?
```

That can come later by connecting invoice imports to PO receiving.

### Minimal AI foundation introduced here

Sprint 2 is the first new provider-backed AI feature, so this is where shared AI plumbing belongs.

Add:

```txt
lib/ai/provider.ts
lib/data/ai-operation-attempts.ts
```

Recommended new table:

```txt
ai_operation_attempts
```

Suggested columns:

```ts
id
organization_id
actor_user_id
feature
status
provider
model
input_tokens
output_tokens
cost_micros
quality_flags
error_code
source_type
source_id
result_type
result_id
created_at
```

Allowed status values:

```txt
pending | succeeded | failed
```

Suggested feature values:

```txt
supplier_invoice_extraction
profit_leak_explanation
menu_engineering_explanation
daily_close_summary
prep_reorder_plan_summary
kitchen_cfo_report
```

Do not migrate recipe photo extraction into this table yet.

### Suggested invoice tables

Use dedicated tables for line-level review.

```txt
supplier_invoice_imports
supplier_invoice_import_lines
```

Header:

```ts
id
organization_id
actor_user_id
supplier_id
supplier_name_raw
invoice_number
invoice_date
currency_code
status // draft, staged, applied, void
ai_attempt_id
created_at
updated_at
```

Lines:

```ts
id
organization_id
import_id
sort_order
raw_text
item_name_raw
matched_ingredient_id
matched_supplier_id
quantity_value
quantity_unit
pack_size_value
pack_size_unit
unit_price_cents
line_total_cents
derived_price_cents
confidence
status // ready, needs_review, ignored, applied
issues
created_at
updated_at
```

Raw line text is customer content. If stored, keep it short, display it only in the review workbench and include it in account export/deletion policy. Prefer deleting raw text after apply if it is not needed for audit.

### Provider output schema

```ts
const supplierInvoiceExtractionSchema = z.object({
  supplier: z.object({
    name: z.string().max(200).nullable(),
    confidence: z.number().min(0).max(1),
  }),
  invoice: z.object({
    number: z.string().max(100).nullable(),
    date: z.string().max(20).nullable(),
    currency: z.string().max(3).nullable(),
  }),
  lines: z.array(
    z.object({
      rawText: z.string().max(300).nullable(),
      itemName: z.string().max(200),
      quantityValue: z.number().positive().nullable(),
      quantityUnit: z.string().max(40).nullable(),
      packSizeValue: z.number().positive().nullable(),
      packSizeUnit: z.string().max(40).nullable(),
      unitPriceCents: z.number().int().nonnegative().nullable(),
      lineTotalCents: z.number().int().nonnegative().nullable(),
      confidence: z.number().min(0).max(1),
    }),
  ).max(300),
  qualityFlags: z.array(z.string().max(80)).max(20),
});
```

### Acceptance criteria

- Upload accepts only supported image/PDF inputs.
- Raw file bytes are discarded after extraction unless a future explicit retention policy is approved.
- AI output is validated with Zod before display.
- Every extracted line is editable.
- Lines missing quantity, pack, unit or price are marked `needs_review`.
- Manager approval is required before creating price observations.
- Applying invoice import creates `ingredient_price_history.source = 'import'`.
- Applying invoice import raises `ingredients.pending_price_cents`.
- Applying invoice import does not update `ingredients.price_cents`.
- Applying invoice import does not post inventory movement.
- Currency must match org currency for MVP.
- VAT/tax ambiguity is surfaced, not guessed.
- Same-org RLS and composite references are covered by tests.
- AI usage and provider cost are recorded in `ai_operation_attempts`.

---

## 8. Sprint 3 - Invoice-to-Profit Impact Loop

### Goal

Turn invoice import from "data entry helper" into a margin-protection workflow.

### User promise

> This invoice changed ingredient costs. Here are the recipes and menus now at risk.

### Scope

After invoice lines are staged/applied as pending price observations, show:

- count of ingredient costs changed;
- ingredients with largest percent increase;
- affected recipes;
- affected menus;
- below-target margin findings;
- suggested selling price where price exists;
- manager actions.

Example:

```txt
Butter increased from 8.20/kg to 9.70/kg.
6 recipes affected.
2 menu items are below the 65% target margin.
Suggested review: Cheesecake Slice from 4.90 to 5.40.
```

### Technical design

Profit Leak Detector should support two modes:

```txt
approved-cost mode
pending-cost impact mode
```

Approved-cost mode:

- uses `ingredients.price_cents`;
- reflects current financial truth.

Pending-cost impact mode:

- uses `pending_price_cents` where present;
- never treats it as approved truth;
- labels output as projected impact.

### Suggested files

```txt
lib/calculations/profit-leaks.ts
lib/data/profit-leaks.ts
lib/data/supplier-invoice-imports.ts
app/(app)/suppliers/invoices/[id]/impact-card.tsx
```

Route placement can be decided by UX:

```txt
/suppliers/invoice-imports/[id]
```

or inside supplier detail if there is already a strong supplier page pattern.

### Acceptance criteria

- Impact is computed from deterministic calculations.
- Pending cost impact is clearly labeled as pending/projected.
- Approved price is unchanged until manager acceptance.
- Accepting pending cost updates active recipe/menu costs on next read.
- Findings link to ingredients, recipes and menus.
- Unknown ingredient matches remain review-only and do not affect profit calculations.
- Tests cover pending price higher, lower, same, missing and zero.

---

## 9. Sprint 4 - AI Explanations and Profit Insight Inbox

### Goal

Add AI where it is strongest: explaining deterministic findings in practical language.

### User promise

> PrepProfit explains why the margin risk matters and what the manager should review.

### Scope

Add:

- "Explain" action on a profit leak finding;
- structured AI explanation schema;
- usage/cost tracking through `ai_operation_attempts`;
- optional persisted short explanation;
- dismiss/resolve state if needed.

Do not ask the model to calculate money. The model receives only compact structured facts.

### Example model input

```json
{
  "findingType": "MENU_BELOW_TARGET_MARGIN",
  "entityName": "Cheesecake Slice",
  "currentPriceCents": 490,
  "currentMarginPercent": 58.0,
  "targetMarginPercent": 65.0,
  "mainDrivers": [
    { "name": "Butter", "priceChangePercent": 18.0 },
    { "name": "Cream cheese", "priceChangePercent": 9.0 }
  ],
  "suggestedPriceCents": 540
}
```

### Example output schema

```ts
const profitLeakExplanationSchema = z.object({
  headline: z.string().max(120),
  explanation: z.string().max(600),
  actionLabel: z.string().max(80),
  riskLevel: z.enum(['low', 'medium', 'high']),
});
```

### Persistence recommendation

Start lean:

- persist attempt metadata in `ai_operation_attempts`;
- persist explanation only if it is useful to avoid repeated provider calls;
- persist dismissals/resolutions by finding fingerprint.

Do not create a broad `ai_insights` table until Menu Engineer or Daily Close also needs the same lifecycle.

### Acceptance criteria

- AI explanation cannot exist without a deterministic finding.
- AI output is schema-validated.
- The model receives compact structured data, not full database records.
- Manager-only access is enforced.
- Cost and token usage are recorded.
- Failed AI explanation does not hide the deterministic finding.
- UI works when AI quota is exhausted.

---

## 10. Sprint 5 - Menu Engineer

### Goal

Use recipe/menu cost and sales volume to tell managers which items to promote, reprice, fix or remove.

### User promise

> PrepProfit shows which menu items are popular, profitable, risky or candidates for removal.

### Prerequisites

- Recipe/menu costs are reliable.
- Sales are being posted or imported.
- Profit Leak Detector already handles missing cost/price data honestly.

### Deterministic classification

Use classic menu engineering:

| Class | Meaning | Action |
|---|---|---|
| Star | high popularity, high profitability | keep/promote |
| Puzzle | low popularity, high profitability | improve visibility |
| Workhorse | high popularity, low profitability | reprice or reduce cost |
| Dog | low popularity, low profitability | remove or reformulate |

Popularity threshold should be deterministic and explainable. For MVP, classify relative to org sales in the selected period rather than using a global magic number.

### Suggested files

```txt
lib/calculations/menu-engineering.ts
lib/calculations/menu-engineering.test.ts
lib/data/menu-engineering.ts
components/app/menus/menu-engineering-matrix.tsx
app/(app)/menus/engineering/page.tsx
```

AI explanation can be added after deterministic classification.

### Acceptance criteria

- Works without an AI provider call.
- Manager-only.
- Posted sales only.
- Void sales excluded.
- Missing sales data gives an empty state.
- Missing cost or missing selling price produces "needs pricing", not fake margin.
- Links back to menu, recipe and sale context.
- Tests cover zero sales, void sales, missing price, missing cost and high-volume/low-margin items.

---

## 11. Sprint 6 - Daily Close Summary

### Goal

Explain what happened after a posted daily close.

### User promise

> After closing the day, PrepProfit summarizes sales, food cost, margin risks and anomalies.

### Scope

For posted sales only:

- gross sales;
- estimated food cost;
- top sellers;
- low-margin sellers;
- missing cost data;
- unusual variance versus comparable days when enough history exists.

AI should summarize deterministic facts. It should not calculate food cost from prose.

### Suggested files

```txt
lib/calculations/daily-close-insights.ts
lib/calculations/daily-close-insights.test.ts
lib/ai/daily-close-summary.ts
lib/data/daily-close-insights.ts
components/app/sales/daily-close-summary-card.tsx
app/(app)/sales/[id]/page.tsx
```

### Acceptance criteria

- Only posted same-org sales can generate summaries.
- Draft and void sales cannot produce misleading summaries.
- Manager-only.
- Summary states when cost data is incomplete.
- AI cost is recorded.
- Tests cover missing cost, missing tax config, void sale and org isolation.

---

## 12. Sprint 7 - Prep/Reorder Planner

### Goal

Turn expected demand into reviewed prep and reorder suggestions.

### User promise

> Tell PrepProfit what you expect to sell. It tells the kitchen what to prep and what to check or reorder.

### Scope

Input options:

- expected covers;
- selected menu;
- selected recipes;
- expected quantities;
- date.

Output:

- prep suggestions by recipe;
- reorder suggestions by ingredient;
- low-stock warnings;
- optional task list draft.

Quantities must come from deterministic recipe scaling and stock calculations.

AI may format the plan, but it cannot invent ingredient quantities.

### Existing anchor

Use task source anchors:

```txt
source_kind = prep
source_recipe_id

source_kind = reorder
source_ingredient_id
```

### Suggested files

```txt
lib/calculations/prep-reorder-plan.ts
lib/calculations/prep-reorder-plan.test.ts
lib/data/prep-reorder-plan.ts
lib/ai/prep-plan-summary.ts
app/(app)/tasks/ai-prep-planner/page.tsx
app/(app)/tasks/ai-prep-planner/actions.ts
```

### Acceptance criteria

- No money shown to kitchen users.
- Manager-only if reorder cost or price impact is shown.
- User reviews before tasks are created.
- Created tasks use existing task source anchors.
- Missing yield, missing recipe lines or deleted ingredients are surfaced.
- Tests cover insufficient stock, missing yield, deleted recipe, deleted ingredient and duplicate task prevention.

---

## 13. Sprint 8 - Weekly CFO Report, then chat later

### Goal

Create a premium management layer over trusted deterministic insights.

### User promise

> PrepProfit tells the owner what to fix this week to protect margin.

### Recommended order

Build weekly report before open-ended chat.

```txt
Profit Leak Detector
-> Invoice Impact
-> Menu Engineer
-> Daily Close Summary
-> Weekly CFO Report
-> Chat
```

### Report contents

- revenue trend;
- estimated food cost trend;
- biggest margin leaks;
- supplier price changes;
- menu items to reprice;
- prep/reorder anomalies if available;
- missing data that limits confidence.

### Chat constraint

Do not build open-ended chat until the report is useful. Chat should query trusted insight modules, not raw database tables directly.

### Acceptance criteria

- Report is manager-only.
- Report is based on structured deterministic insights.
- Missing data is explicit.
- No direct writes from report/chat output.
- Email delivery uses existing email outbox/idempotency pattern if emailed.
- AI usage and cost are recorded.

---

## 14. Entitlements and quotas

Recommended split:

| Feature | Starter | Pro | Business |
|---|---:|---:|---:|
| Recipe photo extraction | 10/mo | 100/mo | 500/mo |
| Profit Leak Detector | top 1 or preview | full | full + advanced |
| Supplier Invoice Reader | 0 or 3 trial | 30/mo | 200/mo |
| Invoice-to-Profit Impact | preview | full | full |
| AI Explanations | limited | 100/mo | 500/mo |
| Menu Engineer | no | basic | full |
| Daily Close Summary | no | 30/mo | 500/mo |
| Prep/Reorder Planner | no | limited | full |
| Weekly CFO Report | no | monthly | weekly |
| Open Chat | no | no | limited/premium |

Important:

- Do not price based only on provider cost.
- AI provider cost is currently small.
- Price based on margin saved and operational time saved.
- Enforce quota before provider call where possible.
- A failed provider call should record failure, but should not consume user-visible quota unless product decides otherwise.

---

## 15. Key technical decisions

### Decision 1: Generic AI ledger

Recommendation:

> Add `ai_operation_attempts` for new features in Sprint 2. Keep `ai_extraction_attempts` untouched.

Reason:

- avoids risky migration of working photo import;
- gives new features consistent cost/usage tracking;
- keeps backwards compatibility.

### Decision 2: Invoice import tables

Recommendation:

> Use dedicated `supplier_invoice_imports` and `supplier_invoice_import_lines` tables for MVP.

Reason:

- invoice review is line-level and match-heavy;
- generic import jobs are optimized for recipe/import staging;
- dedicated tables keep the workflow easier to test and reason about.

### Decision 3: Price provenance

Recommendation:

> Invoice import lines should create `ingredient_price_history.source = 'import'` and set `pending_price_cents`.

Optional schema addition:

```txt
ingredient_price_history.source_invoice_import_line_id
```

If added, follow the repo precedent for provenance columns:

- index by organization and provenance id;
- avoid raw customer content;
- decide whether it needs a strict FK or provenance-only nullable link.

### Decision 4: Target margin

Recommendation:

> Use existing `MARGIN_THRESHOLDS.green = 65` for MVP, then add org-level target margin later.

Future schema:

```txt
organization_settings.target_margin_bps
```

Later overrides:

```txt
recipes.target_margin_bps
menus.target_margin_bps
```

Do not add all three levels in MVP.

### Decision 5: AI insight persistence

Recommendation:

> Start on-demand. Persist dismissals by finding fingerprint. Add generic `ai_insights` after multiple features need shared lifecycle.

Reason:

- avoids premature generic modeling;
- keeps Sprint 1 smaller;
- still supports a future insight inbox cleanly.

### Decision 6: Invoice and VAT handling

Recommendation:

> For MVP, require invoice currency to match org currency and treat VAT/tax as informational unless the existing purchase-price logic explicitly supports gross/net choice.

Do not silently mix gross and net prices.

---

## 16. Test strategy

### 16.1 Pure calculation tests

Required for:

- profit leak detection;
- pending price impact;
- menu engineering classification;
- daily close insight pack;
- prep/reorder calculations.

Examples:

- recipe margin drops after ingredient price increase;
- menu item below target margin is detected;
- pending price does not become approved price;
- missing price creates a pricing-required finding;
- incomplete menu cost stays incomplete;
- zero sales does not create fake popularity.

### 16.2 Data and RLS tests

Required for every new table.

Examples:

- org A cannot read org B invoice imports;
- org A cannot stage org B import line;
- org A cannot read org B AI attempt;
- same-org composite references prevent cross-org links;
- business table is included in RLS list.

### 16.3 RBAC and entitlement tests

Examples:

- kitchen role cannot see profit leaks;
- kitchen role cannot run invoice cost AI;
- starter quota is enforced before provider call;
- pro/business quotas are applied correctly;
- AI quota exhaustion leaves deterministic findings visible.

### 16.4 AI schema tests

Examples:

- provider output missing required field;
- invalid enum;
- too many lines;
- overly long text;
- malformed currency;
- impossible quantity/price;
- provider failure maps to stable error code.

### 16.5 Integration tests

Required scenario:

```txt
invoice extraction
-> review lines
-> apply price observation
-> pending price set
-> profit leak impact appears
-> manager accepts pending cost
-> approved cost changes
-> active recipe/menu margins refresh
```

---

## 17. Launch gates before marketing the AI promise

### Gate G1 - No silent financial writes

AI must not silently update:

- approved ingredient prices;
- menu selling prices;
- recipe selling prices;
- transactions;
- sales;
- receipts;
- inventory movements;
- payroll.

### Gate G2 - Review-first workflow

All extracted invoice lines and generated operational plans must be editable and confirmable before write.

### Gate G3 - Deterministic money calculations

Every margin, food cost, price impact and suggested price must come from tested deterministic modules.

### Gate G4 - Incomplete data honesty

The UI must explicitly say when results are limited by:

- missing ingredient price;
- missing recipe yield;
- missing selling price;
- missing sales data;
- missing menu component;
- missing stock data;
- unknown invoice line match.

### Gate G5 - Usage and cost metering

Every provider call records:

- organization;
- actor;
- feature;
- provider;
- model;
- status;
- token counts;
- `cost_micros`;
- quality flags;
- stable error code.

### Gate G6 - RBAC and RLS

Financial AI is manager-only and tenant-isolated.

### Gate G7 - Demo-quality result

The launch demo must support this clean flow:

```txt
Upload supplier invoice
-> ingredient price changes detected
-> affected recipes shown
-> affected menus shown
-> under-target margin highlighted
-> manager sees suggested review action
```

---

## 18. First implementation slices

### Slice 1.1 - Pure profit leak calculations

Build:

- `lib/calculations/profit-leaks.ts`;
- unit tests;
- no DB;
- no UI;
- no AI.

Done when:

- findings are deterministic;
- missing prices and incomplete menus are handled honestly;
- suggested price uses existing margin helper.

### Slice 1.2 - Profit leak data loader

Build:

- org-scoped data loader;
- active recipes, menus and ingredients only;
- pending price projection support.

Done when:

- loader uses `withOrg`;
- tests cover org scoping and deleted/trash rows.

### Slice 1.3 - Dashboard card

Build:

- manager-only dashboard card;
- top 5 findings;
- links to entities;
- empty/loading/error states.

Done when:

- kitchen role cannot access;
- UI handles no data and incomplete data.

### Slice 2.1 - AI operation ledger

Build:

- `ai_operation_attempts`;
- RLS;
- data helpers;
- quota helper per feature.

Done when:

- pending/succeeded/failed lifecycle is tested;
- usage count works;
- no raw content is stored.

### Slice 2.2 - Invoice extraction route

Build:

- upload validation;
- provider wrapper;
- Zod output validation;
- attempt lifecycle.

Done when:

- bad files are rejected;
- provider failures produce stable errors;
- raw bytes are discarded.

### Slice 2.3 - Invoice review workbench

Build:

- editable invoice draft;
- supplier matching;
- ingredient matching;
- line statuses and issues.

Done when:

- no line is silently applied;
- unknown lines require review.

### Slice 2.4 - Apply invoice as price observations

Build:

- apply action;
- create history rows with `source = 'import'`;
- set `pending_price_cents`;
- refresh profit impact.

Done when:

- approved prices remain unchanged;
- pending price acceptance still uses existing manager flow.

---

## 19. Recommended developer instruction

Give the dev this instruction:

```txt
Do not start by coding every AI module.

Build Sprint 1 first:
- pure Profit Leak calculation module;
- tests;
- org-scoped loader;
- manager-only dashboard card.

No AI provider call in Sprint 1.

In Sprint 2, add the minimal generic AI operation ledger and provider wrapper needed for Supplier Invoice Reader. Keep the existing recipe photo extraction ledger untouched.

Each slice should end with lint, typecheck, tests and build. Do not silently update financial data from AI output.
```

---

## 20. Final product direction

PrepProfit should be positioned as:

> The AI margin protection system for small kitchens.

Best launch promise:

> Upload recipes and supplier invoices. PrepProfit keeps food costs current, finds underpriced dishes and shows what to review before margin disappears.

The best first customer value is not "AI creates recipes." It is:

> PrepProfit notices when your numbers stop making sense.

