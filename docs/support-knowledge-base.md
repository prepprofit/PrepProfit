# PrepProfit — Support Knowledge Base (for Crisp / Hugo AI training)

> **How to use this file.** This is CUSTOMER-FACING help content to train the Crisp
> "Hugo" AI Agent (AI Agent → Train → upload this file), and/or to seed your Crisp
> Helpdesk articles. Instructions (tone/escalation) live elsewhere — this file is the
> *knowledge*.
>
> **Owner action before publishing:** search for `⟨CONFIRMAR⟩` and either fill in the
> exact in-app navigation/labels or delete the line. Those are places where the precise
> UI path matters and should be verified against the live app so Hugo never gives a
> wrong step. Also confirm the support email and any prices before go-live.
>
> Written in English (Hugo replies in the customer's own language regardless). Ask if
> you want a Portuguese/French copy too.

---

## 1. About PrepProfit

**What it is.** PrepProfit is a financial-management platform for food businesses —
restaurants, bakeries, patisseries, and other kitchens. It replaces spreadsheets with
tested workflows for recipe costing, inventory, financials, break-even, invoicing,
payroll, and AI-assisted recipe extraction from photos.

**Who it's for.** Chefs, bakers, patissiers, and small food-business owners who want to
know their true costs and margins without being accountants.

**The core idea.** Enter your ingredients and recipes once; PrepProfit keeps costs,
yields, and margins accurate as prices change, so you always know what a dish really
costs and what to charge.

**What PrepProfit is NOT.** It is not tax, accounting, or legal advice, and it does not
file taxes for you. For those, consult a professional.

---

## 2. Getting started

1. **Create your account** and your business (organization).
2. **Add ingredients** with their purchase price and unit — this is the foundation of
   every cost calculation.
3. **Create recipes** from those ingredients; PrepProfit computes cost per portion,
   yield/loss, hidden costs, and margin automatically.
4. **Set your prices** and check the margin each dish earns.
5. Explore the other modules (inventory, financials, break-even, invoices, payroll)
   as you need them.

**Tip:** you can also create a recipe draft from a **photo** using AI extraction (see
§4) — useful for importing an existing recipe card or cookbook page.

⟨CONFIRMAR⟩ Exact first-run/onboarding steps and menu labels.

---

## 3. Plans & pricing

PrepProfit has four tiers. Prices are in euros, billed monthly.

| Plan | Price | Users | Recipes | What's included |
|---|---|---|---|---|
| **Free (Starter)** | €0 | 1 | up to 10 | All operational modules: recipes, ingredients, menus, suppliers, inventory, productions, sales, tasks, allergens, purchase orders. AI photo extraction: **10/month**. |
| **Solo** | €19/mo | 1 | unlimited | Everything in Free **+ break-even simulator**. AI extraction: **40/month**. |
| **Pro** | €29/mo | 5 | unlimited | Everything in Solo **+ invoices**. AI extraction: **100/month**. |
| **Business** | €79/mo | unlimited | unlimited | Everything in Pro **+ payroll + advanced document/report workflows**. AI extraction: **500/month**. |

**Feature ladder (quick reference):**
- Break-even → **Solo and up**
- Invoices → **Pro and up**
- Payroll & advanced documents → **Business**
- AI photo recipe extraction → **every tier, including Free** (only the monthly quota
  differs).

### 3.1 Free 14-day trial (reverse trial)
Every **new** business automatically starts with **Business-level access — all features
unlocked — for 14 days**. No card required to start. After 14 days, if you haven't
subscribed, the account moves to the **Free (Starter)** plan and paid features lock,
but your data stays.

**During the trial**, AI extraction is available but capped at **50 per AI feature per
month** (an anti-abuse limit), not the full Business volume.

### 3.2 Common pricing questions
- **"Do I need a credit card to try it?"** No — the 14-day trial starts automatically
  for new businesses. ⟨CONFIRMAR⟩ card-at-signup policy.
- **"What happens to my data if I don't subscribe?"** It stays. You keep Free-plan
  access; features above Free are locked until you upgrade.
- **"Can I change plans later?"** Yes, upgrade or downgrade anytime. ⟨CONFIRMAR⟩ exact
  billing page path.
- **"Is there an annual plan / discount?"** ⟨CONFIRMAR⟩

---

## 4. AI photo recipe extraction

**What it does.** Take a photo of a recipe (printed card, cookbook page, supplier sheet,
or handwritten note) and PrepProfit's AI reads it into a **draft** recipe you review
before saving.

**Key points customers should know:**
- It is **available on every plan**, including Free — only the monthly quota differs
  (Free 10, Solo 40, Pro 100, Business 500; trial 50/feature).
- The AI creates a **draft you must review and confirm** — it never creates a final
  recipe or ingredient automatically. You stay in control.
- **New ingredients found in a photo start with a price of €0** and are flagged as
  "needs pricing." This is intentional: the AI does not trust a price it "reads" from an
  image, so you set the real price. This keeps your costs honest.
- Best results come from clear, well-lit, flat photos. Blurry or angled photos may miss
  lines — you can fix or add lines in the review step before saving.

**Common questions:**
- **"It missed / misread a line."** Correct it in the review screen before confirming;
  nothing is saved until you confirm.
- **"Why is the ingredient cost €0?"** New ingredients from a photo need you to set the
  price (see above). Add the price and the cost updates.
- **"I ran out of extractions this month."** You've hit your plan's monthly AI quota.
  It resets next month, or upgrade for a higher quota.

⟨CONFIRMAR⟩ exact location of the photo-import button and the review/confirm flow labels.

---

## 5. Feature guides

### 5.1 Recipes & costing
Build recipes from your ingredients. PrepProfit calculates **cost per portion, yield and
loss, hidden costs, and margin** automatically, and updates them when ingredient prices
change. Organize recipes in folders; deleted recipes go to Trash and can be restored.

### 5.2 Ingredients
The price and unit you set on each ingredient drive every recipe cost. Keep purchase
prices current for accurate margins. An ingredient with no price shows as "needs pricing."

### 5.3 Inventory
Track stock with movements on an authoritative ledger, and get low-stock alerts so you
reorder in time.

### 5.4 Financials
Record transactions, categorize them, view dashboards, and export to CSV. Financial
figures are manager-only (see §6).

### 5.5 Break-even simulator *(Solo and up)*
Run scenarios to see the sales volume you need to cover costs and reach a target profit.

### 5.6 Invoices *(Pro and up)*
Manage customers and the full invoice lifecycle: **draft → issue → pay → void**, with
gap-free sequential numbering. Issued invoices can be printed or exported as PDF.

### 5.7 Payroll *(Business)*
Manage employees and shifts and generate period summaries.

### 5.8 Kitchen operations
Suppliers, purchase orders, menus, productions, sales, allergens, and tasks help you run
day-to-day operations alongside the financial tools. (Availability by plan — all are in
Free's operational set.)

### 5.9 Imports
Import data from CSV/XLSX files through a staged preview: you review what will be
imported before confirming. A missing or blank price imports at €0 and is flagged "needs
pricing." ⟨CONFIRMAR⟩ which entities support import in the current release.

### 5.10 Documents & exports
Generate printable/PDF/XLSX outputs (e.g., invoices, reports, recipe cards). Advanced
document/report workflows are a Business feature. ⟨CONFIRMAR⟩ current document list.

---

## 6. Accounts, users & roles

- A business (organization) can have multiple team members, up to the plan's user limit
  (Free/Solo 1, Pro 5, Business unlimited).
- There are two roles:
  - **Manager** — full access, including financials, costs, margins, pricing, invoices,
    payroll, settings, and billing.
  - **Kitchen** — operational access (recipes, ingredients, inventory, allergens, tasks,
    etc.) but **does not see costs, margins, prices, or financial figures**, and cannot
    edit prices. This is by design, to keep sensitive financial data restricted.
- **"My kitchen staff can't see recipe costs."** That is expected — cost/margin/price is
  manager-only. Ask an account manager to view those.
- ⟨CONFIRMAR⟩ exact steps to invite a teammate and assign a role.

---

## 7. Billing & subscription

- Subscriptions are billed monthly in euros.
- Upgrade/downgrade anytime; access changes to match the new plan.
- ⟨CONFIRMAR⟩ where billing lives in the app, accepted payment methods, invoices/receipts
  for the subscription, and cancellation steps.
- **Anything about charges, refunds, failed payments, or cancellations should be handled
  by a human** — Hugo should escalate these rather than guess.

---

## 8. Data, security & privacy

- Each business's data is isolated from every other business — one company can never see
  another's data.
- Your recipes, ingredients, and financials belong to you and remain available on the
  Free plan if a trial or subscription ends.
- PrepProfit does not sell your data. ⟨CONFIRMAR⟩ link to the privacy policy / data-export
  (GDPR) request process.

---

## 9. Troubleshooting & common questions

- **"I can't log in."** ⟨CONFIRMAR⟩ password-reset path. If it persists, escalate to a
  human with the email used to sign up (never ask for the password).
- **"A feature is locked / greyed out."** It likely belongs to a higher plan, or your
  trial ended. Check §3 for what each plan includes.
- **"My margins look wrong."** Usually an ingredient price is missing or out of date —
  check for "needs pricing" ingredients and confirm purchase prices and units.
- **"I hit my AI extraction limit."** That's the monthly quota for your plan (§4); it
  resets next month, or upgrade for more.
- **"Something's broken / I found a bug."** Escalate to a human with a short description
  and, if possible, what you did just before it happened.

---

## 10. Contact & escalation

For anything Hugo can't resolve — billing, account, data, bugs, or a request to speak to
a person — a human on the PrepProfit team will follow up.

- **In-app chat:** this window (a person is notified when a conversation is escalated).
- **Email:** ⟨CONFIRMAR⟩ e.g. info@prepprofit.com
- **Website:** ⟨CONFIRMAR⟩ https://prepprofit.com

Hugo should **not** invent policies, prices, dates, or features. When unsure, it should
say so and escalate.
