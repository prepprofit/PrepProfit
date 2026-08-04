# PrepProfit Landing Page Copy Implementation Plan - Senior Revised

## Verdict

Do not send the original plan to implementation unchanged.

The copy direction is strong, but the original plan leaves repo-specific traps open:

1. The current hero preview is wrapped in `HeroVideo`, but `DEMO_VIDEO_URL` is empty. If the dev only changes the hero CTA, the page can still show a clickable play overlay that opens a "Demo video coming soon" modal.
2. `marketing.problem` already exists in `lib/i18n/messages/en.json`, but `app/(marketing)/page.tsx` does not render a problem section. Editing those strings alone will do nothing.
3. Fake proof is not limited to `TestimonialsMarquee`. The final CTA renders five stars plus `marketing.subscribe.rating`; remove that too.
4. `FaqSection` hardcodes five questions. Adding `q6` and `q7` to the JSON will not render them unless the component changes.
5. Yearly pricing needs a pre-flight check. The public marketing cards have a yearly toggle, but the committed Clerk catalogue only makes the monthly org-plan prices obvious. Do not ship yearly copy unless checkout supports it.
6. Trial copy must be precise: the reverse trial grants Business-level feature access, but AI usage during trial is capped by the AI trial quota logic.

Use this revised plan instead of the original.

---

## Repo Ground Truth

Files to treat as the contract:

- `app/(marketing)/page.tsx`
  - Current structure: header, hero, `HeroVideo` with `AppPreview`, audience strip, `FeaturedBento`, `ProductTour`, `TestimonialsMarquee`, `PricingSection`, `FaqSection`, final CTA, footer.
  - The product tour already has `id="how-it-works"`.
  - Hero secondary CTA currently points to `/sign-in`.
  - Final CTA secondary currently points to `/sign-in`.

- `components/marketing/hero-video.tsx`
  - `DEMO_VIDEO_URL = ''`.
  - The component opens a coming-soon video modal.
  - Do not keep this as the hero preview wrapper unless a real demo URL is added and verified.

- `components/marketing/faq-section.tsx`
  - `QUESTIONS = ['q1', 'q2', 'q3', 'q4', 'q5']`.
  - Rendering seven FAQs requires changing this constant or making it data-driven.

- `components/marketing/pricing-section.tsx` and `components/marketing/pricing-cards.tsx`
  - Public pricing cards are custom marketing UI.
  - They read `marketing.pricing.*` from `lib/i18n/messages/en.json`.
  - The yearly toggle depends on `priceYear` strings.

- `lib/i18n/messages/en.json`
  - Marketing copy lives under `marketing`.
  - `marketing.problem` exists but is currently dormant.
  - `marketing.testimonials` contains fabricated names, quotes, roles, and star proof.
  - There is also an old non-marketing AI-photo upgrade string saying Pro/Business only. Do not fix it in this landing-page PR unless scope is expanded.

- `public/screenshots/`
  - Real seeded demo screenshots exist: `dashboard.webp`, `recipe-costing.webp`, `insights.webp`, `break-even.webp`.

- `public/icons/`
  - Audience icons exist for chefs, bakeries, catering, patisseries, cafes, food trucks, and restaurants.

- `lib/entitlements.ts`
  - Free is `starter` internally.
  - Free/Starter: 10 recipes, 1 seat.
  - Solo: unlimited recipes, 1 seat.
  - Pro: unlimited recipes, 5 seats.
  - Business: unlimited recipes, unlimited seats.
  - AI photo extraction is universal and quota-metered:
    - Free/Starter: 10/month
    - Solo: 40/month
    - Pro: 100/month
    - Business: 500/month
  - `REVERSE_TRIAL_DAYS = 14`.
  - Active reverse trial resolves to Business-level feature access.
  - Trial AI allowances are clamped by the trial AI cap logic; do not imply full Business AI volume during trial.

- `clerk/billing.json`
  - Paid org plans are Solo $19, Pro $29, Business $79 in USD.
  - Solo includes `break_even`.
  - Pro includes `invoices` and `break_even`.
  - Business includes `invoices`, `break_even`, `payroll`, and `advanced_documents`.
  - Paid-plan `free_trial_enabled` is false because the reverse trial is implemented in the app.

- `app/(app)/pricing/page.tsx` and `app/(app)/onboarding/onboarding-stepper.tsx`
  - Checkout uses Clerk's `<PricingTable for="organization" />`.
  - Public pricing must match what users can actually buy.

---

## Scope

Allowed files:

- `app/(marketing)/page.tsx`
- `lib/i18n/messages/en.json`
- `components/marketing/marketing-header.tsx`
- `components/marketing/app-preview.tsx`
- `components/marketing/featured-bento.tsx`
- `components/marketing/product-tour.tsx`
- `components/marketing/pricing-section.tsx`
- `components/marketing/pricing-cards.tsx`
- `components/marketing/faq-section.tsx`
- `components/marketing/testimonials-marquee.tsx`

Expected new files:

- `components/marketing/problem-section.tsx`
- `components/marketing/proof-section.tsx`

Only if yearly pricing behavior changes:

- `tests/billing-catalogue.test.ts`

Do not touch:

- Auth routes
- Clerk webhook logic
- Billing entitlement logic
- Database schema
- Server actions
- AI extraction logic
- Recipe calculations
- App internals outside the public marketing page

---

## Pricing Pre-Flight Gate

Before editing, the dev must answer:

Does the live Clerk organization checkout offer yearly plans matching the public yearly prices?

Decision rule:

- If yearly checkout is verified, keep the yearly toggle and make the copy match checkout.
- If yearly checkout is not verified, do not ship yearly pricing on the public landing page. Remove or hide the yearly marketing toggle and update the relevant pricing consistency test in the same implementation PR.
- Do not change billing mechanics in this copy PR.

---

## Page Structure To Implement

1. Header
2. Hero
3. Product preview
4. Audience strip
5. Problem section
6. Feature bento
7. Product tour
8. Proof section
9. Pricing
10. FAQ
11. Final CTA
12. Footer

Important:

- Product tour keeps `id="how-it-works"`.
- Hero secondary CTA links to `#how-it-works`.
- Final CTA secondary links to `#how-it-works`.
- Remove rendered `TestimonialsMarquee`.
- Remove `HeroVideo` usage from the hero preview unless a real demo URL exists.

---

## Copy To Implement

### Hero

Headline:

```text
Stop pricing your recipes with messy spreadsheets.
```

Subhead:

```text
PrepProfit helps chefs, bakeries, and caterers organize recipes, calculate real costs, track margins, and price every product with confidence.
```

Supporting line:

```text
No more scattered recipe cards. No more outdated ingredient costs. No more guessing what each product actually makes.
```

Primary CTA:

```text
Start free - 14 days of Business-level access
```

Link:

```text
/sign-up
```

Secondary CTA:

```text
See the product
```

Link:

```text
#how-it-works
```

### Audience

Title:

```text
Built for food businesses that still run costing in spreadsheets
```

Subtitle:

```text
For chefs, bakeries, caterers, and small food teams who need one place for recipes, costs, margins, and pricing.
```

Labels:

- Chefs
- Bakeries
- Caterers
- Patisseries
- Cafes
- Food trucks

### Problem Section

Title:

```text
Your spreadsheet is free. The mistakes are not.
```

Subtitle:

```text
When ingredient prices change, formulas break, or recipes live in five different places, your margins disappear quietly.
```

Before cards:

- Recipes everywhere: Recipe cards, notebooks, WhatsApp messages, and spreadsheets make it hard to keep products consistent.
- Ingredient prices drift: Butter, flour, and cream change price, but your old spreadsheet does not always catch the margin impact.
- Margins disappear silently: A popular product can look successful while barely making profit after yield, waste, packaging, and labor.
- Pricing becomes guesswork: You end up defending prices with instinct instead of numbers you can trust.

After cards:

- One recipe source of truth: Keep ingredients, yields, portions, and selling prices organized in one place.
- Update one cost, see the impact: Change an ingredient once and see which recipes need attention.
- Numbers you can defend: See what each product actually costs, what it sells for, and the margin it leaves behind.
- Price with confidence: Use real costs and break-even numbers before changing your menu or accepting a catering job.

### Features

Use these feature angles:

- Recipe costing that stays current
- Ingredient price changes without spreadsheet surgery
- AI photo recipe extraction, reviewed by you
- Supplier invoices into reviewed cost impact
- Break-even and pricing decisions
- Roles, privacy, and exports

Supplier invoice copy must preserve the real safety contract: extracted invoice lines become reviewed/pending cost observations; approved costs change only when accepted.

### Product Tour

Title:

```text
See the product on real sample numbers
```

Subtitle:

```text
A quick look at how PrepProfit connects recipe costing, margin insights, and break-even planning.
```

Tabs:

- Dashboard: Margins at a glance
- Recipe costing: Cost, price, and margin
- Insights: Find silent profit leaks
- Break-even: Know what you need to sell

### Proof Section

Title:

```text
Proof you can see on screen
```

Subtitle:

```text
PrepProfit is built around visible numbers, reviewed changes, and product evidence, not magic claims.
```

Worked example:

```text
Example: Croissant
Ingredient cost: $0.87
Selling price: $3.50
Margin: 75.1%

If butter changes from $8.20 to $9.70, PrepProfit can show the affected recipe cost so you can review the impact before your margin slips.
```

Evidence cards:

- Real screenshots: The product tour uses real seeded demo screens for dashboard, recipe costing, insights, and break-even.
- Reviewed AI: AI creates drafts. You review before anything becomes final.
- Export anytime: Your recipes and business data are not trapped. Export clean files when you need them.
- Role-based access: Managers can see financials while kitchen staff use operational tools without exposing sensitive numbers.

### Pricing

Title:

```text
Start with everything. Keep what fits.
```

Subtitle:

```text
Every new workspace starts with 14 days of Business-level feature access, no card required. After that, choose a paid plan or continue on Free. Your data stays either way.
```

Monthly plan copy:

- Free: For costing your first recipes. 1 user. Up to 10 recipes. Core recipe costing tools. AI photo extraction, 10/month.
- Solo: For solo chefs and owner-operators. 1 user. Unlimited recipes. Break-even planning. AI photo extraction, 40/month.
- Pro: For growing kitchens that need better pricing control. 5 users. Unlimited recipes. Invoices and operations. AI photo extraction, 100/month.
- Business: For teams that need full back-office control. Unlimited users. Payroll, reports, and advanced documents. Role-based access. AI photo extraction, 500/month.

Do not say the trial gives full Business AI usage volume.

### FAQ

Update `FaqSection` so all seven questions render.

Questions:

1. Why not just keep using my spreadsheet?
2. How is this different from a free recipe cost calculator?
3. Do I have to rebuild everything from scratch?
4. What happens after the 14-day trial?
5. Does AI change my recipes automatically?
6. Can I export my data?
7. Can my team use it?

Use the answers from the original plan, but update trial wording to "Business-level feature access" rather than implying unrestricted AI volume.

### Final CTA

Title:

```text
Know what your recipes actually make.
```

Subtitle:

```text
Start with 14 days of Business-level feature access. No card required. If you do not choose a plan, keep using Free and keep your data.
```

Primary CTA:

```text
Create your account
```

Link:

```text
/sign-up
```

Secondary CTA:

```text
See the product
```

Link:

```text
#how-it-works
```

Remove the star/rating row.

---

## Claude Code Prompt To Use

```text
You are working on PrepProfit, a Next.js 15 SaaS for recipe costing and food business margin management.

Implement the revised public landing page positioning:
"Stop pricing your recipes with messy spreadsheets."

This is a marketing-page copy and structure pass only.

Do not change product logic, billing behavior, auth, database schema, server actions, AI extraction logic, recipe calculations, or app internals.

Before editing, inspect:
- app/(marketing)/page.tsx
- lib/i18n/messages/en.json
- components/marketing/*
- lib/entitlements.ts
- clerk/billing.json
- tests/billing-catalogue.test.ts
- package.json

Ground rules:
1. No fake testimonials, fake customer names, fake star ratings, or fake customer proof.
2. Do not keep the hero demo/play overlay unless a real demo URL exists and works.
3. Hero secondary CTA must link to #how-it-works.
4. Add a visible problem section. Do not only update dormant marketing.problem strings.
5. Replace TestimonialsMarquee with an honest proof section.
6. Expand FAQ rendering to seven questions.
7. Keep pricing in USD and aligned with lib/entitlements.ts, clerk/billing.json, and billing tests.
8. Verify yearly pricing before shipping a yearly toggle. If yearly checkout is not verified, remove the public yearly toggle and update the pricing consistency test in the same PR.
9. Trial copy may say Business-level feature access, but must not imply full Business AI usage volume during trial.
10. Keep US-English.
11. Preserve existing visual style and component patterns.

Before making edits, give me a short implementation plan that names the exact files you will touch and the yearly-pricing decision.
Wait for approval before editing.
```

---

## Validation

Run:

```bash
npm run lint
npm run typecheck
npm run build
```

If pricing copy or yearly behavior changes, also run:

```bash
npm test -- tests/billing-catalogue.test.ts tests/entitlements.test.ts
```

Document any failure with the exact command and error.

---

## Acceptance Criteria

The implementation is done only when:

1. Hero uses the approved spreadsheet pain angle.
2. Hero secondary CTA links to `#how-it-works`.
3. No coming-soon demo modal or fake video CTA remains on the landing page.
4. Audience copy focuses on chefs, bakeries, caterers, and small food teams.
5. A visible problem section exists.
6. Feature copy preserves review-first AI and supplier invoice safety contracts.
7. Product tour still uses the real screenshots in `public/screenshots/`.
8. Fake testimonials are gone.
9. Fake star ratings and fake rating copy are gone.
10. A proof section exists with product evidence and a worked example.
11. Pricing remains USD and matches enforced plan caps.
12. Public yearly pricing is either verified against checkout or not shown.
13. FAQ renders all seven questions.
14. Final CTA links to `/sign-up` and `#how-it-works`.
15. No product logic, auth, billing, database, AI, recipe calculation, or app-internal behavior changed.
16. `npm run lint` passes.
17. `npm run typecheck` passes.
18. `npm run build` passes, or any unrelated existing failure is documented with the exact error.

Suggested commit:

```bash
git add app components lib
git commit -m "Update landing page copy and proof sections"
```
