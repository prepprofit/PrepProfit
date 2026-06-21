# Release note — Sprint F4: kitchen financial lockdown

**Behavior change (RBAC).** Kitchen users no longer see or edit money on the recipe,
ingredient, and inventory surfaces. This reverses the previous behavior where cost,
margin, and selling price were visible to every role.

## What changed for `kitchen` users
- **Recipes:** the recipe editor shows the operational recipe only — name, folder,
  yield, ingredient lines (name / quantity / unit), and notes. The per-line cost
  column, the cost breakdown card, the pricing/margin card, the labor/energy/
  packaging cost inputs, and the "Cost sheet" button are hidden.
- **Ingredients:** the price column and the new-ingredient price field are hidden.
  Kitchen can still add and edit ingredients **operationally** (name, dimension,
  supplier); a kitchen-created ingredient starts at price 0 and is flagged "needs
  pricing" for a manager to price later.
- **Recipe cost sheet (PDF / print):** now **manager-only** (kitchen sees "no
  access" / receives HTTP 403).
- **Inventory:** unchanged in appearance (it never showed money); the price is no
  longer sent to the browser at all.

## What this does NOT change
- Managers (`org:admin`) keep the full cost/margin/pricing experience.
- Financials, transactions, invoices, payroll, break-even, and the dashboard were
  already manager-only — untouched.
- Recipe/ingredient names remain searchable by all roles; deep-links open the
  money-stripped views.

## Why / how it's enforced (for reviewers)
Enforcement is server-side in three layers, not UI hiding (CLAUDE.md: "UI hiding is
never enough"):
1. **Data** — kitchen pages and Server Action responses ship typed DTOs with the
   financial keys **omitted** (`priceCents`, recipe cost/selling-price), so a cost
   never reaches the kitchen client.
2. **UI** — the money components render only when `canSeeRecipeCosts(role)` is true.
3. **Writes** — kitchen create/update actions validate against operational-only Zod
   schemas; create coerces money to 0/null, update preserves the stored money, and
   price edits + changing the `dimension` of an already-priced ingredient are refused
   (`FORBIDDEN`) for non-managers.

No database migration. New predicate: `canSeeRecipeCosts` (`lib/auth.ts`).
