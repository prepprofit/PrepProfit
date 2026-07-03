# Plan - AI usage meter (used / remaining) UI

**Status:** SENIOR-REVISED PLAN. Ready for implementation; not implemented yet.
**Audit date:** 2026-07-03.
**Scope:** current-month AI usage visibility in `/billing` plus an inline photo-import hint.
**Migration:** NONE. Reuses `ai_extraction_attempts` and `ai_operation_attempts`.

---

## 1. Senior audit verdict

The original direction was right, but the draft was not yet senior-ready. It left
repo-settled decisions open and had two concrete contract errors:

1. It said `/recipes/import/photo` is kitchen-reachable. It is not. The page gates
   with `canAccessFinancials(getUserRole())`, the upload route gates with
   `isManager()`, and the recipes index only shows the photo-import link to managers.
   The meter must preserve manager-only access.
2. It proposed the photo i18n key under `recipes.import.photo.*`, but the real
   namespace is `recipes.importPhoto`.
3. It did not fully specify the difference between display usage and cap enforcement.
   The repo enforces caps with "reserved" usage (`succeeded` plus recent `pending`)
   under advisory locks, while the user-facing billed usage is `succeeded` only.
   The UI must encode that distinction explicitly.
4. It planned a trial note but did not return entitlement `source` from the new
   all-limits resolver, so the UI would not have enough data without another lookup.
5. It omitted `photo-workbench.tsx` from the touched files even though the hint belongs
   beside the upload controls inside the client workbench.

This rewritten plan closes those gaps and is the implementation contract.

---

## 2. Goal

Give managers a proactive view of monthly AI quota usage before an AI request hits
`USAGE_LIMIT_REACHED`.

Deliverables:

1. A server helper for current-month AI usage, including `used`, `reserved`,
   `remaining`, and `availableNow` per metered feature.
2. A manager-only `/billing` card titled "AI usage this month".
3. A manager-only inline hint on `/recipes/import/photo` near the upload controls for
   the photo extraction quota.

Out of scope:

- No cap changes.
- No new AI feature.
- No historical graph.
- No email/notification.
- No schema migration.
- No RBAC widening for kitchen users.

---

## 3. Ground truth from the repo

### 3.1 Metered AI features

Use this six-row product registry. Do not derive UI rows by iterating all
`AI_OPERATION_FEATURES`, because `menu_engineering_explanation` is declared in the DB
enum but has no writer and no entitlement limit.

| UI key | UI label | Limit source | Ledger | Ledger feature |
|---|---|---|---|---|
| `photo_recipe_extraction` | Photo recipe extraction | `AI_EXTRACTION_MONTHLY_LIMIT` / `aiExtractionMonthlyLimit()` | `ai_extraction_attempts` | n/a |
| `supplier_invoice_extraction` | Supplier invoice reader | `SUPPLIER_INVOICE_MONTHLY_LIMIT` / `supplierInvoiceMonthlyLimit()` | `ai_operation_attempts` | `supplier_invoice_extraction` |
| `profit_leak_explanation` | Profit-leak explanation | `PROFIT_LEAK_EXPLANATION_MONTHLY_LIMIT` / `profitLeakExplanationMonthlyLimit()` | `ai_operation_attempts` | `profit_leak_explanation` |
| `daily_close_summary` | Daily-close summary | `DAILY_CLOSE_SUMMARY_MONTHLY_LIMIT` / `dailyCloseSummaryMonthlyLimit()` | `ai_operation_attempts` | `daily_close_summary` |
| `prep_reorder_plan_summary` | Prep/reorder summary | `PREP_PLAN_SUMMARY_MONTHLY_LIMIT` / `prepPlanSummaryMonthlyLimit()` | `ai_operation_attempts` | `prep_reorder_plan_summary` |
| `kitchen_cfo_report` | Weekly CFO report | `WEEKLY_CFO_REPORT_MONTHLY_LIMIT` / `weeklyCfoReportMonthlyLimit()` | `ai_operation_attempts` | `kitchen_cfo_report` |

Current entitlement facts:

- The reverse trial resolves as Business access, but AI quotas are capped with
  `min(businessQuota, TRIAL_AI_MONTHLY_CAP)`. CFO remains 30 because Business CFO is
  already below 50.
- Existing single-feature limit helpers must keep their current public return shape:
  `{ limit, tier }`. Tests currently assert exact equality.
- The new all-limits helper may return `source`, but the old helpers must not unless
  their tests are intentionally updated.

### 3.2 Usage math

There are two distinct numbers:

- `used`: count of `succeeded` rows since UTC month start. This is the billed/display
  usage figure.
- `reserved`: count of `succeeded` rows since UTC month start plus still-in-flight
  `pending` rows within the existing in-flight horizon. This is what the cap gate uses
  to avoid concurrent overshoot.

Derived fields:

- `remaining = Math.max(0, limit - used)`
- `availableNow = Math.max(0, limit - reserved)`
- Progress bar percentage uses `used / limit`, clamped to 100%.
- If `used > limit` after a downgrade or trial/cap change, show the truthful
  `used / limit`, `remaining = 0`, and a full bar.

Billing should primarily display `used / limit`. The photo upload hint should display
`availableNow / limit` so it does not promise a slot that is already reserved by an
in-flight upload.

### 3.3 RBAC

All meter UI in this slice is manager-only:

- `/billing` is manager-only already.
- `/recipes/import/photo` is manager-only already.
- `/api/recipes/import/photo` is manager-only already.
- Supplier invoice reader, profit-leak explanation, daily-close summary,
  prep/reorder summary, and CFO report actions/routes all gate with `isManager()`.

Do not add a kitchen-visible usage hint in this slice. `CLAUDE.md` already lists
billing and AI extraction usage controls as sensitive surfaces, so no `CLAUDE.md`
change is needed unless product policy changes.

---

## 4. Implementation design

### 4.1 Shared feature registry

Add `lib/ai/usage-features.ts` as a dependency-free registry:

```ts
export const AI_USAGE_FEATURES = [
  'photo_recipe_extraction',
  'supplier_invoice_extraction',
  'profit_leak_explanation',
  'daily_close_summary',
  'prep_reorder_plan_summary',
  'kitchen_cfo_report',
] as const;

export type AiUsageFeature = (typeof AI_USAGE_FEATURES)[number];

export const AI_OPERATION_USAGE_FEATURES = [
  'supplier_invoice_extraction',
  'profit_leak_explanation',
  'daily_close_summary',
  'prep_reorder_plan_summary',
  'kitchen_cfo_report',
] as const;
```

Also export a display-order mapping from `AiUsageFeature` to the i18n label key. Keep
this file import-light so it can be used by entitlements, data, and UI without pulling
Drizzle or provider code into unrelated modules.

### 4.2 Entitlements

Change `lib/entitlements.ts`:

- Add a pure internal resolver that takes an `EffectiveEntitlementState` plus one
  limit table and returns the effective AI limit.
- Add:

```ts
export type AiMonthlyLimit = {
  limit: number;
  tier: PlanTier;
  source: EntitlementSource;
};

export async function allAiMonthlyLimits(): Promise<
  Record<AiUsageFeature, AiMonthlyLimit>
>;
```

Rules:

- Resolve `getEffectiveEntitlementState()` once.
- Apply the same trial clamp as the existing helpers.
- Include `source` so the billing panel can show a light trial note.
- Refactor the six existing helpers to use the same pure resolver, but keep returning
  only `{ limit, tier }` to avoid breaking current callers/tests.

### 4.3 Data helpers

Add `lib/data/ai-usage.ts`:

```ts
export type AiUsageRow = {
  feature: AiUsageFeature;
  used: number;
  reserved: number;
  limit: number;
  remaining: number;
  availableNow: number;
};

export type AiUsageSummary = {
  tier: PlanTier;
  source: EntitlementSource;
  resetAt: Date;
  rows: AiUsageRow[];
};

export async function getAiUsageThisMonth(
  now?: Date,
): Promise<AiUsageSummary>;

export async function getPhotoExtractionUsageThisMonth(
  now?: Date,
): Promise<AiUsageRow>;
```

Implementation contract:

- Derive `organizationId` server-side with `getOrgId()`.
- Read limits through `allAiMonthlyLimits()`.
- Use UTC calendar month boundaries. `resetAt` is the first day of the next UTC month.
- Run usage reads inside `withOrg(organizationId, ...)`.
- Return rows in `AI_USAGE_FEATURES` order.
- Default missing grouped-count rows to zero.
- Exclude `menu_engineering_explanation`.

Add efficient count helpers:

- In `lib/data/ai-extraction.ts`, add `countExtractionUsageSince(tx, org, monthStart, now)`
  returning `{ used, reserved }`. It should use the existing `EXTRACTION_INFLIGHT_MS`
  semantics.
- In `lib/data/ai-operation-attempts.ts`, add
  `countOperationUsageByFeatureSince(tx, org, monthStart, now)` returning
  `Map<AiOperationFeature, { used: number; reserved: number }>` for the generic
  operation ledger. It should use one grouped query with the existing
  `OPERATION_INFLIGHT_MS` semantics.

Do not use these display helpers for enforcement. Existing route/action gates remain
the authority for cap checks.

### 4.4 Billing panel

Add `app/(app)/billing/ai-usage-panel.tsx` as a server component and render it from
`app/(app)/billing/page.tsx` after the current plan card.

UI rules:

- Keep the existing quiet card style.
- Show one row per feature with `limit > 0`.
- Show label, `used / limit`, and a thin div-based progress bar.
- Clamp the bar to 100%, but never clamp the displayed `used` number.
- Show one reset hint: "Resets on {date}" using the app formatter.
- If `source === 'trial'`, show one light note that these are trial allowances.
- If `reserved > used`, show a small muted note for in-flight usage. Do not make it
  the headline metric.
- No hardcoded user-visible strings.

### 4.5 Photo inline hint

Change both:

- `app/(app)/recipes/import/photo/page.tsx`
- `app/(app)/recipes/import/photo/photo-workbench.tsx`

Server page:

- Keep the existing manager-only gate.
- Load `getPhotoExtractionUsageThisMonth()` and pass the row into
  `PhotoImportWorkbench`.

Client workbench:

- Add a `photoUsage` prop.
- Render the hint inside the upload card near the upload actions.
- Use `recipes.importPhoto.upload.usageLeft` for the normal copy, with
  `{ available, limit }`.
- Use `recipes.importPhoto.upload.usageExhausted` when `availableNow <= 0`.
- Do not rely on the client hint for security. The upload route remains authoritative.
- If an extraction returns 200, decrement the local `availableNow` by 1 so "Start over"
  does not show stale availability in the same browser session. Do not decrement for
  provider failures, validation failures, or `USAGE_LIMIT_REACHED`.

### 4.6 i18n

Add keys under existing namespaces:

- `billing.aiUsage.title`
- `billing.aiUsage.resetsOn`
- `billing.aiUsage.used`
- `billing.aiUsage.remaining`
- `billing.aiUsage.inFlight`
- `billing.aiUsage.trialNote`
- `billing.aiUsage.features.photo_recipe_extraction`
- `billing.aiUsage.features.supplier_invoice_extraction`
- `billing.aiUsage.features.profit_leak_explanation`
- `billing.aiUsage.features.daily_close_summary`
- `billing.aiUsage.features.prep_reorder_plan_summary`
- `billing.aiUsage.features.kitchen_cfo_report`
- `recipes.importPhoto.upload.usageLeft`
- `recipes.importPhoto.upload.usageExhausted`

Do not use `recipes.import.photo.*`; that namespace does not match the current page.

---

## 5. Planned files

Add:

- `lib/ai/usage-features.ts`
- `lib/data/ai-usage.ts`
- `app/(app)/billing/ai-usage-panel.tsx`
- `tests/ai-usage.test.ts`

Change:

- `lib/entitlements.ts`
- `lib/data/ai-extraction.ts`
- `lib/data/ai-operation-attempts.ts`
- `app/(app)/billing/page.tsx`
- `app/(app)/recipes/import/photo/page.tsx`
- `app/(app)/recipes/import/photo/photo-workbench.tsx`
- `lib/i18n/messages/en.json`
- `tests/entitlements.test.ts`
- Existing AI ledger tests if the new count helpers fit better there than in
  `tests/ai-usage.test.ts`

Do not change:

- Database schema/migrations.
- RBAC policy for kitchen users.
- Cap enforcement routes/actions.
- `CLAUDE.md`, unless product policy is intentionally changed.

---

## 6. Testing plan

### 6.1 Entitlements

Update `tests/entitlements.test.ts`:

- `allAiMonthlyLimits()` resolves all six features from one effective state.
- Paid Business returns full limits.
- Trial returns clamped limits, with CFO remaining 30.
- Free/expired trial returns Starter limits.
- Auth failure fails closed to Starter/free.
- Existing six single-feature helpers still match the new all-limits result and keep
  returning exactly `{ limit, tier }`.

### 6.2 Usage data

Add `tests/ai-usage.test.ts` or extend existing ledger tests:

- Seed current-month `succeeded`, current-month fresh `pending`, stale `pending`,
  `failed`, previous-month rows, and another org's rows.
- Assert `used` counts only current-month succeeded rows.
- Assert `reserved` counts current-month succeeded plus fresh pending only.
- Assert `remaining` and `availableNow` math.
- Assert grouped generic counts match individual features.
- Assert `menu_engineering_explanation` never appears in UI rows even if a row exists.
- Assert org isolation through `withOrg`/RLS.
- Assert `resetAt` is first day of the next UTC month.

### 6.3 UI/contracts

- Billing page remains manager-only and renders `NoAccess` for kitchen.
- Photo page remains manager-only and renders `NoAccess` for kitchen.
- Photo workbench renders the usage hint in the upload state only.
- Photo workbench decrements local availability after a successful extraction only.
- Strings are all from `next-intl`; no hardcoded UI copy.

Full gate before merge:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

---

## 7. Implementation order

1. Add the usage feature registry and `allAiMonthlyLimits()` with entitlement tests.
2. Add combined usage count helpers and `lib/data/ai-usage.ts` with PGlite tests.
3. Add the billing panel and i18n keys.
4. Add the photo inline hint and client-side availability decrement.
5. Run the full gate and manually inspect `/billing` plus `/recipes/import/photo`.

---

## 8. Definition of done

- Managers can see current-month AI usage on `/billing`.
- Managers can see photo extraction availability before uploading a photo.
- Kitchen users do not gain access to billing, photo import, or AI usage controls.
- The displayed billing usage cannot drift from ledger semantics: `used` is succeeded,
  `reserved` is succeeded plus fresh pending, and the route/action gates remain the
  source of truth.
- Trial, over-cap, zero-limit, and reset-date states are deterministic and tested.
