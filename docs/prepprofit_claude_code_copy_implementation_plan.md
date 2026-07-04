# PrepProfit — Claude Code Implementation Plan for New Landing Page Copy

## Goal

Implement the revised PrepProfit landing page positioning and copy inside the existing Next.js project without changing product logic, billing mechanics, authentication, database behavior, or app functionality.

The new positioning is:

> Stop pricing your recipes with messy spreadsheets.

The page should speak mainly to **chefs, bakeries, and caterers** who currently manage recipe costs, ingredient prices, margins, and pricing in spreadsheets, notebooks, WhatsApp messages, or scattered files.

The job is not to invent a new strategy. The strategy is approved. The job is to carefully implement the revised copy and page structure in the codebase.

---

## Important Product Truths That Must Stay Accurate

Do not publish copy that conflicts with these mechanics:

1. Currency is **USD ($)**.
2. Plans are:
   - Free: $0
   - Solo: $19/mo
   - Pro: $29/mo
   - Business: $79/mo
3. Every new account starts with **14 days of Business-level access**, no card required.
4. After the trial, if the user does not choose a paid plan, the account automatically falls back to Free.
5. Data is **never deleted** on downgrade.
6. Free plan includes:
   - 1 user
   - Up to 10 recipes
   - AI photo extraction included, 10/month
7. AI photo extraction exists on **every tier**. Do not describe it as paid-only.
8. AI drafts are reviewed by the user. Nothing should imply that AI auto-saves final recipe data without confirmation.
9. Screenshots in `public/screenshots/` are real product screenshots from a seeded demo account:
   - `dashboard.webp`
   - `recipe-costing.webp`
   - `insights.webp`
   - `break-even.webp`
10. Do not use fake testimonials. If the current testimonial section is not based on real customers, replace it with a proof/product evidence section.

---

## Repository Areas Likely Involved

Focus mostly on marketing files.

Primary files:

- `app/(marketing)/page.tsx`
- `lib/i18n/messages/en.json`
- `components/marketing/marketing-header.tsx`
- `components/marketing/hero-video.tsx`
- `components/marketing/app-preview.tsx`
- `components/marketing/featured-bento.tsx`
- `components/marketing/product-tour.tsx`
- `components/marketing/pricing-section.tsx`
- `components/marketing/pricing-cards.tsx`
- `components/marketing/faq-section.tsx`
- `components/marketing/testimonials-marquee.tsx`

Possible new file:

- `components/marketing/proof-section.tsx`

Do not touch:

- auth routes
- billing logic
- database schema
- server actions
- AI extraction logic
- recipe calculation logic
- dashboard/product app internals unless a marketing screenshot or text import requires it

---

## Recommended Claude Code Workflow

### Step 1 — Start in plan mode

Start Claude Code in plan mode before editing:

```bash
claude --permission-mode plan
```

Or enter plan mode inside the session if available.

Do not allow edits until Claude has inspected the marketing page structure and produced an implementation plan.

---

### Step 2 — Give Claude Code this instruction

Paste this into Claude Code:

```text
You are working on PrepProfit, a Next.js 15 SaaS for recipe costing and food business margin management.

Your task is to implement the approved revised marketing copy on the public landing page.

Do not invent new product claims. Do not change product logic. Do not change billing behavior. Do not change auth, database, server actions, or app functionality.

Main positioning:
"Stop pricing your recipes with messy spreadsheets."

ICP:
Chefs, bakeries, and caterers who currently use spreadsheets, notebooks, WhatsApp, or scattered files to manage recipe costs, ingredient prices, margins, and menu pricing.

Implementation goals:
1. Update the hero copy.
2. Change the secondary hero CTA from Sign in / demo video to "See the product →" linking to the product tour section.
3. Add or revise a problem section that makes the spreadsheet pain obvious.
4. Add a proof section using honest product evidence, not testimonials.
5. Remove or replace fake/non-real testimonials.
6. Keep pricing in USD and aligned with the real product mechanics.
7. Add FAQ copy that handles spreadsheets, free calculators, AI review, supplier invoices, downgrade behavior, and data export.
8. Keep US-English.
9. Maintain the existing visual style and component patterns.
10. Run lint, typecheck, and build after changes.

Before editing, inspect:
- app/(marketing)/page.tsx
- lib/i18n/messages/en.json
- components/marketing/*
- package.json

Then give me a short implementation plan and wait for approval before making changes.
```

---

## Page Structure to Implement

Recommended final structure:

1. Header
2. Hero
3. Product preview
4. Audience / ICP strip
5. Problem section: spreadsheets are costing you money
6. Feature bento
7. Product tour
8. Proof section
9. Pricing
10. FAQ
11. Final CTA
12. Footer

---

## Hero Copy

### Primary hero

Use this:

```text
Stop pricing your recipes with messy spreadsheets.
```

### Hero subhead

Use this:

```text
PrepProfit helps chefs, bakeries and caterers organize recipes, calculate real costs, track margins and price every product with confidence.
```

### Supporting line

Use this either in the hero, under the product preview, or near the problem section:

```text
No more scattered recipe cards. No more outdated ingredient costs. No more guessing what each product actually makes.
```

### Primary CTA

```text
Start free — 14 days of everything
```

Link:

```text
/sign-up
```

### Secondary CTA

```text
See the product →
```

Link:

```text
#how-it-works
```

Do not use “Watch 60-sec demo” unless a real demo video exists and the link works.

---

## Audience Section

Current copy is too broad. Narrow the angle.

### Title

```text
Built for food businesses that still run costing in spreadsheets
```

### Subtitle

```text
For chefs, bakeries, caterers and small food teams who need one place for recipes, costs, margins and pricing.
```

Recommended audience labels:

- Chefs
- Bakeries
- Caterers
- Patisseries
- Cafés
- Food trucks

Restaurants can stay as a secondary segment, but the main page should not feel like generic restaurant software.

---

## Problem Section

If the current `marketing.problem` strings are not rendered, add a visible problem section after the hero/product preview or after the audience strip.

### Section title

```text
Your spreadsheet is free. The mistakes are not.
```

### Subtitle

```text
When ingredient prices change, formulas break, or recipes live in five different places, your margins disappear quietly.
```

### Before cards

Use 4 cards:

#### Recipes everywhere

```text
Recipe cards, notebooks, WhatsApp messages and spreadsheets make it hard to keep products consistent.
```

#### Ingredient prices drift

```text
Butter, flour and cream change price — but your old spreadsheet does not always catch the margin impact.
```

#### Margins disappear silently

```text
A popular product can look successful while barely making profit after yield, waste, packaging and labor.
```

#### Pricing becomes guesswork

```text
You end up defending prices with instinct instead of numbers you can trust.
```

### After cards

Use 4 cards:

#### One recipe source of truth

```text
Keep ingredients, yields, portions and selling prices organized in one place.
```

#### Update one cost, see the impact

```text
Change an ingredient once and see which recipes need attention.
```

#### Numbers you can defend

```text
See what each product actually costs, what it sells for and the margin it leaves behind.
```

#### Price with confidence

```text
Use real costs and break-even numbers before changing your menu or accepting a catering job.
```

Avoid repeating “messy spreadsheets” too many times after the hero. Use variation: cost drift, silent losses, scattered recipes, stale prices, margin impact, numbers you can defend.

---

## Feature Section Copy

The product’s strongest sellable features are:

1. Recipe costing and margin calculation
2. Ingredient price updates that affect recipe margins
3. AI photo recipe extraction
4. Supplier invoice import/review path
5. Profit insights / profit leak detection
6. Break-even planning
7. Roles and data export as trust markers

Recommended revised feature titles:

### Recipe costing that stays current

```text
Build recipes with ingredients, yield, loss, portions and selling price. PrepProfit shows what the product actually costs and the margin it leaves behind.
```

### Ingredient price changes without spreadsheet surgery

```text
Update an ingredient once and see which recipes are affected, instead of rebuilding formulas across multiple files.
```

### AI photo recipe extraction, reviewed by you

```text
Take a photo of a recipe card and get a draft you can review before anything is saved.
```

### Supplier invoices into margin impact

```text
Upload or import supplier invoice data, review the changes and keep ingredient costs closer to reality.
```

### Break-even and pricing decisions

```text
Understand how much you need to sell, what a product should cost and when a catering job or menu item stops making sense.
```

### Roles, privacy and exports

```text
Keep sensitive numbers manager-only, export your data anytime and run the business without locking your numbers in a fragile sheet.
```

---

## Proof Section

Add a new section to replace fake testimonials or sit before pricing.

### Title

```text
Proof you can see on screen
```

### Subtitle

```text
PrepProfit is built around visible numbers, reviewed changes and product evidence — not magic claims.
```

### Worked example card

```text
Example: Croissant
Ingredient cost: $0.87
Selling price: $3.50
Margin: 75.1%

If butter changes from $8.20 to $9.70, PrepProfit recalculates the affected recipe cost so you can review the impact before your margin slips.
```

### Product evidence cards

#### Real screenshots

```text
The product tour uses real seeded demo screens for dashboard, recipe costing, insights and break-even.
```

#### Reviewed AI

```text
AI creates drafts. You review before anything becomes final.
```

#### Export anytime

```text
Your recipes and business data are not trapped. Export clean files when you need them.
```

#### Role-based access

```text
Managers can see financials while kitchen staff can use operational tools without exposing sensitive numbers.
```

Do not use fabricated customer names, fake quotes or fake star ratings.

---

## Product Tour

Keep the existing product tour and real screenshots.

Recommended title:

```text
See the product on real sample numbers
```

Recommended subtitle:

```text
A quick look at how PrepProfit connects recipe costing, margin insights and break-even planning.
```

Recommended tab copy:

### Dashboard

```text
Margins at a glance
```

### Recipe costing

```text
Cost, price and margin
```

### Insights

```text
Find silent profit leaks
```

### Break-even

```text
Know what you need to sell
```

---

## Pricing Section

Keep the mechanics accurate.

### Title

```text
Start with everything. Keep what fits.
```

### Subtitle

```text
Every new workspace starts with 14 days of Business-level access, no card required. After that, choose a paid plan or continue on Free — your data stays either way.
```

### Plan copy

#### Free

Tagline:

```text
For costing your first recipes.
```

Features:

```text
1 user
Up to 10 recipes
Core recipe costing tools
AI photo extraction, 10/month
```

#### Solo — $19/mo

Tagline:

```text
For solo chefs and owner-operators.
```

Features:

```text
1 user
Unlimited recipes
Break-even planning
AI photo extraction, 40/month
```

#### Pro — $29/mo

Tagline:

```text
For growing kitchens that need better pricing control.
```

Features:

```text
5 users
Unlimited recipes
Invoices and operations
AI photo extraction, 100/month
```

#### Business — $79/mo

Tagline:

```text
For teams that need full back-office control.
```

Features:

```text
Unlimited users
Payroll, reports and advanced documents
Role-based access
AI photo extraction, 500/month
```

Make sure the code still uses `$` and that yearly pricing stays consistent with the existing mechanics.

---

## FAQ Section

Recommended FAQ questions and answers.

### Q1. Why not just keep using my spreadsheet?

```text
A spreadsheet can work when you have a few products. It starts failing when ingredient prices change, formulas break, recipes multiply and costs like yield, waste, packaging and labor are easy to miss. PrepProfit keeps the costing logic in the product so you are not rebuilding formulas every time something changes.
```

### Q2. How is this different from a free recipe cost calculator?

```text
A calculator gives you one answer once. PrepProfit gives you an organized system for recipes, ingredients, margins, invoices, inventory, exports and pricing decisions over time.
```

### Q3. Do I have to rebuild everything from scratch?

```text
No. You can import data from CSV or Excel, photograph a recipe for a reviewed AI draft, or upload supplier invoice data and review the changes before they affect your numbers.
```

### Q4. What happens after the 14-day trial?

```text
Every new workspace starts with 14 days of Business-level access — no card required. If you do not choose a paid plan, your workspace moves to Free automatically. Your data is not deleted.
```

### Q5. Does AI change my recipes automatically?

```text
No. AI creates a draft for you to review. Nothing becomes final until you confirm it.
```

### Q6. Can I export my data?

```text
Yes. PrepProfit is designed so you can bring data in and export clean files when you need them.
```

### Q7. Can my team use it?

```text
Yes. Paid plans support team workflows and role-based access, so managers can keep financial data protected while kitchen staff use the operational tools they need.
```

---

## Final CTA

### Title

```text
Know what your recipes actually make.
```

### Subtitle

```text
Start with 14 days of Business-level access. No card required. If you do not choose a plan, keep using Free and keep your data.
```

### Primary CTA

```text
Create your account
```

Link:

```text
/sign-up
```

### Secondary CTA

```text
See the product
```

Link:

```text
#how-it-works
```

---

## Headline Test Plan

Do not over-engineer A/B testing in code unless there is already an analytics/testing setup.

Recommended first test:

### Variant A — Negative-first pain

```text
Stop pricing your recipes with messy spreadsheets.
```

### Variant B — Positive-first outcome

```text
Know exactly which recipes make money.
```

Run Variant A first for the initial launch unless an A/B framework already exists.

Decision metric:

```text
Signup rate / trial start rate
```

Not button clicks.

Minimum learning approach:

1. Run Variant A on the first cold email / organic / community traffic batch.
2. Track visitors to signups.
3. If conversion is weak, switch to Variant B manually.
4. Compare signup rate with similar traffic quality.

Do not make the page too complex just to test headlines at launch.

---

## Cold Email Copy Implementation Notes

This does not necessarily go into the codebase unless there is a marketing docs folder. But keep it in the project docs if useful.

### First-touch plain text, no link

```text
Subject: quick question

Hi {{first_name}},

I noticed {{personalized_reason}} and wanted to ask — are you still pricing recipes or products in spreadsheets?

I built PrepProfit for chefs, bakeries and caterers who need one place to organize recipes, calculate real costs and see margins before they price a product.

Worth sending you a quick example?

And if this is not relevant, just reply “no” and I won’t follow up.

André
```

### First-touch with soft link, only after deliverability is safe

```text
Subject: recipe costing question

Hi {{first_name}},

I noticed {{personalized_reason}} and thought this might be relevant.

I built PrepProfit for food businesses that still price recipes in spreadsheets — it helps organize recipes, update ingredient costs and see the real margin on every product.

Here’s the product: https://www.prepprofit.com/

Worth taking a look, or is this not a priority right now?

If this is not relevant, just reply “no” and I won’t follow up.

André
```

---

## Acceptance Criteria

Claude Code should finish only when:

1. Landing page hero uses the approved spreadsheet pain angle.
2. Secondary hero CTA links to the product tour, not sign-in or a non-existent video.
3. No fake testimonials remain.
4. A proof section exists with product evidence and a worked example.
5. Pricing is in USD and matches real plan mechanics.
6. FAQ handles spreadsheet/free calculator objections.
7. Copy is US-English.
8. Copy variation avoids repeating the same phrases too often.
9. Existing real screenshots are still used.
10. No product logic, billing logic or auth behavior changed.
11. `npm run lint` passes.
12. `npm run typecheck` passes.
13. `npm run build` passes or any build issue is clearly documented with the exact error.

---

## Suggested Git Commit

```bash
git add app components lib
git commit -m "Update marketing copy and positioning"
```

---

## Biggest Reason to Use Claude Code for This

The biggest win is not that Claude Code writes better copy. The copy direction is already decided.

The biggest win is that Claude Code can update the landing page across multiple connected files without you manually chasing every string and component:

- marketing page structure
- translation JSON
- CTA links
- pricing copy
- FAQ content
- testimonial removal
- proof section component
- build/type/lint validation

That is where mistakes usually happen when editing manually.
