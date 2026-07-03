# Flows Onboarding - Senior-Reviewed Implementation Plan

**Status:** revised after repo + installed SDK audit. The original direction is right, but
the first draft was not implementation-ready. This version locks the real SDK contracts,
the current PrepProfit layout shape, the data boundaries, and the exact places the dev
should touch.

**Goal:** use Flows to turn the 14-day reverse trial into an activation system: an
embedded onboarding checklist, small contextual nudges, and optional "just did X" moments.
Flows remains dashboard-authored for copy, targeting, block wiring, and rollout. This plan
covers only the code-side contracts and surfaces.

**Scope rule for the dev:** implement only the files listed in this plan. Do not change
billing/entitlement logic, Clerk plan names, database schema, migrations, RBAC, or the
existing trial UI unless this plan explicitly says so.

---

## 0. Audit Verdict

The first draft needed revision before coding. The blocking issues were:

- `FlowsSlot` is typed by the installed SDK as `<FlowsSlot id="..." />`, not `slotId`.
  Using `slotId` will fail typecheck.
- The current root `app/layout.tsx` wraps the entire app in `Flows`. The draft proposed
  reading trial/entitlement/activation data there, but those values are app-session and
  active-org concerns. Keep the root layout mostly generic and move the Flows provider
  into the authenticated app layout for v1.
- Trial surfaces already exist in the repo (`getTrialView`, `DashboardTrialCard`,
  `TrialTopBanner`, sidebar AI meter). The Flows work should compose with them, not
  recreate or replace them.
- `ComponentProps` from `@flows/react` only guarantees `__flows` plus the template props
  configured for that component. It does not magically provide `continue()`, `dismiss()`,
  `title`, or `body` for every custom component.
- `tier` must use the real `PlanTier` union: `starter | solo | pro | business`. There is
  no `free` tier; `free` is an entitlement `source`.
- `hasRunPhotoExtraction` must mean "ever had a successful photo extraction", not
  "used this month's quota". Do not reuse the monthly sidebar meter for this activation
  property.
- Imperative `startWorkflow()` calls are only for moments. Persistent checklist completion
  must be property-driven so imports, refreshes, and cross-device sessions stay correct.

---

## 1. Current Repo Ground Truth

Already installed and wired:

- `package.json` includes `@flows/react` and `@flows/react-components`.
- `app/flows.tsx` is a client component wrapping `FlowsProvider`.
- `app/layout.tsx` currently mounts `<Flows>{children}</Flows>` inside the provider stack.
- `.env.example` documents `NEXT_PUBLIC_FLOWS_ORGANIZATION_ID`.
- `app/(app)/layout.tsx` already computes role, trial view, sidebar AI meter, and lowest
  paid price for the authenticated shell.
- `app/(app)/dashboard/page.tsx` already renders `DashboardTrialCard` when `trial` exists.
- `lib/trial.ts` exports `getTrialView()`.
- `lib/entitlements.ts` exposes `PlanTier = 'starter' | 'solo' | 'pro' | 'business'` and
  `EntitlementSource = 'trial' | 'paid' | 'free' | 'comped'`.
- `lib/data/recipes.ts` already exports `countActiveRecipes(db, organizationId)`.

Installed SDK contracts verified locally:

- `FlowsSlotProps` is `{ id: string; placeholder?: ReactNode; limit?: number }`.
- `startWorkflow(blockKey: string): Promise<void>` exists and only starts a matching
  manual-start block when the published workflow, frequency, and targeting allow it.
- `FlowsProvider` accepts `organizationId`, `environment`, `userId`, `userProperties`,
  `components`, `tourComponents`, `surveyComponents`, and `LinkComponent`.
- `@flows/react-components` exports default Basics V2 component names such as
  `BasicsV2Card`, `BasicsV2FloatingChecklist`, `BasicsV2Modal`, and `BasicsV2Tooltip`.

---

## 2. Locked Naming Contract

These strings must match exactly between this repo and the Flows dashboard.

### User Properties

Send only coarse product/activation state. Do not send names, emails, recipe names,
ingredient names, revenue, margin, COGS, uploaded-image data, or other business-sensitive
payloads to Flows.

| Property | Type | Meaning |
| --- | --- | --- |
| `clerkOrgId` | string | Active Clerk org id. Already sent today. |
| `role` | string | PrepProfit app role: `manager` or `kitchen`. Prefer the server-derived role from `getUserRole()`. |
| `source` | string | Entitlement source: `trial`, `paid`, `free`, or `comped`. |
| `tier` | string | Effective plan tier: `starter`, `solo`, `pro`, or `business`. During reverse trial this is `business`. |
| `isTrial` | boolean | Convenience flag for dashboard targeting: `source === 'trial'`. |
| `trialDaysLeft` | number or null | Whole days left while trial is active; `null` outside trial. |
| `recipeCount` | number | Count of active, non-trashed recipes for the active org. |
| `hasIngredient` | boolean | Active org has at least one active, non-trashed ingredient. |
| `hasRunPhotoExtraction` | boolean | Active org has at least one lifetime `succeeded` row in `ai_extraction_attempts`. |

Do not send `trialEndsAt` in v1 unless the owner proves a dashboard rule needs the exact
date. `trialDaysLeft` is enough for day-3/day-1 targeting and leaks less precise account
metadata to a third party.

### Slot IDs

| Slot id | Code placement |
| --- | --- |
| `dashboard-onboarding` | Authenticated dashboard, below the existing trial card and above the rest of the dashboard content. |

Use:

```tsx
<FlowsSlot id="dashboard-onboarding" />
```

Do not use `slotId`.

### Manual Workflow Keys

| Block key | Fired when |
| --- | --- |
| `first-recipe-created` | A recipe create flow succeeds. This is a celebration/nudge only; checklist completion still comes from `recipeCount >= 1`. |
| `first-photo-extraction-done` | `/api/recipes/import/photo` returns a successful extraction draft. Checklist completion still comes from `hasRunPhotoExtraction`. |

Keep these as non-blocking best-effort calls. A Flows outage must never break recipe
creation or photo extraction.

### Custom Component Keys

Register custom PrepProfit components with explicit, prefixed keys. The Flows dashboard
must select these same component keys:

- `PrepProfitCard`
- `PrepProfitChecklist`
- `PrepProfitModal`
- `PrepProfitTooltip`

Keep the library defaults registered too, so existing/default Flows blocks still render.

---

## 3. Provider Architecture

### Decision

Move the Flows provider from the root layout into `app/(app)/layout.tsx` for v1.

Reason: this onboarding work is authenticated-app onboarding. The root layout also serves
public/signed-out routes, and app activation properties depend on the active org/session.
Computing those properties in `app/layout.tsx` would make global layout behavior more
fragile than necessary.

### Files

- Edit `app/layout.tsx` to remove the `<Flows>` wrapper and render `{children}` directly
  inside `NextIntlClientProvider`.
- Edit `app/(app)/layout.tsx` to import `Flows` and wrap the `AppShell`.
- Edit `app/flows.tsx` to accept server-derived user properties and merge them with Clerk
  client identity.

### Shape

In `app/(app)/layout.tsx`, compute the Flows payload alongside the values already read
there:

```tsx
const role = await getUserRole();
const canSeeFinance = canAccessFinancials(role);
const [entitlement, trial, activation] = canSeeFinance
  ? await Promise.all([
      getEffectiveEntitlementState(),
      getTrialView(),
      getActivationSnapshot(),
    ])
  : [null, null, null];

const flowsUser = {
  role,
  source: entitlement?.source ?? 'free',
  tier: entitlement?.tier ?? 'starter',
  isTrial: trial != null,
  trialDaysLeft: trial?.daysLeft ?? null,
  recipeCount: activation?.recipeCount ?? 0,
  hasIngredient: activation?.hasIngredient ?? false,
  hasRunPhotoExtraction: activation?.hasRunPhotoExtraction ?? false,
};

return (
  <Flows user={flowsUser}>
    <AppShell ...>{children}</AppShell>
  </Flows>
);
```

Implementation detail: the snippet above is intentionally schematic. The dev must avoid
duplicating entitlement reads already encapsulated by `getTrialView()` and the current
layout. If `getEffectiveEntitlementState()` is needed for `source`/`tier`, read it once in
this layout and reuse it.

In `app/flows.tsx`, keep the existing skip behavior when
`NEXT_PUBLIC_FLOWS_ORGANIZATION_ID` is missing:

```tsx
const { userId, orgId } = useAuth();

<FlowsProvider
  organizationId={ORGANIZATION_ID}
  environment={process.env.NEXT_PUBLIC_FLOWS_ENVIRONMENT ?? 'production'}
  userId={userId ?? null}
  userProperties={{
    ...(orgId ? { clerkOrgId: orgId } : {}),
    ...user,
  }}
  components={{ ...defaultComponents, ...ppComponents }}
  tourComponents={{ ...tourComponents }}
  surveyComponents={{ ...surveyComponents }}
  LinkComponent={Link}
>
```

Add `NEXT_PUBLIC_FLOWS_ENVIRONMENT=production` to `.env.example` if the environment value
is made configurable.

---

## 4. Activation Snapshot Read Model

Create `lib/data/activation.ts`.

Purpose: one cheap, org-scoped read model for Flows activation properties. Do not load full
recipe or ingredient lists just to send booleans to Flows.

API:

```ts
export type ActivationSnapshot = {
  recipeCount: number;
  hasIngredient: boolean;
  hasRunPhotoExtraction: boolean;
};

export async function getActivationSnapshot(): Promise<ActivationSnapshot>;
```

Implementation requirements:

- Use `withOrg` / active organization scoping. Never accept `organizationId` from the
  client.
- Use `countActiveRecipes(db, organizationId)` for `recipeCount`.
- Add a small ingredient existence read instead of using `listIngredients()`, for example
  `select({ id: ingredients.id }).from(ingredients).where(org + deletedAt is null).limit(1)`.
- Add a lifetime photo-extraction existence read:
  `ai_extraction_attempts.organization_id = organizationId` and `status = 'succeeded'`,
  `limit(1)`.
- Do not use `getPhotoExtractionUsageSummaryThisMonth()` for `hasRunPhotoExtraction`.
  Monthly usage resets; onboarding activation should not.
- Keep the helper server-only. Do not expose it through an API route.

Tests to add:

- Returns zero/false values for a fresh org.
- Counts only active non-trashed recipes.
- `hasIngredient` ignores soft-deleted ingredients.
- `hasRunPhotoExtraction` is true for any historical succeeded photo extraction, including
  previous months.
- Failed/pending extraction attempts do not count.
- Rows from another org never affect the snapshot.

---

## 5. Custom Flows Components

Create `components/app/flows/`:

- `card.tsx`
- `checklist.tsx`
- `modal.tsx`
- `tooltip.tsx`
- `index.ts`

Register them in `app/flows.tsx`:

```tsx
import * as defaultComponents from '@flows/react-components';
import * as ppComponents from '@/components/app/flows';

components={{ ...defaultComponents, ...ppComponents }}
```

Component guidance:

- Export exactly the keys listed in Section 2.
- Use existing UI primitives (`Card`, `Button`, etc.) and `lucide-react` icons where useful.
- Match the current trial/dashboard visual language: quiet B2B surface, clear progress,
  restrained accent color, no marketing hero treatment.
- Keep card radii and spacing consistent with existing dashboard cards.
- Support light/dark mode.
- Use `next-intl` only for strings owned by the component itself. Dashboard-authored Flows
  copy arrives via props and should remain owner-editable in Flows.
- Build against explicit props for each custom component. Example: if `PrepProfitCard`
  needs `title`, `body`, `primaryCtaLabel`, and `primaryCtaHref`, define that contract and
  configure the Flows dashboard block template to send those fields.
- Do not assume `continue()` or `dismiss()` exist on plain `ComponentProps`. If a modal or
  tour step needs a Flows action, type that component against the exact SDK/component prop
  contract that provides it, or pass an explicit action field from the dashboard template.

Acceptance:

- A dashboard-authored block using `PrepProfitCard` renders in the app with PrepProfit
  styling.
- The default Basics V2 components still render if the owner uses a default block.
- Keyboard focus, close/dismiss controls, and text wrapping are professional on desktop and
  mobile.

---

## 6. Dashboard Slot

Edit `app/(app)/dashboard/page.tsx`.

Import:

```tsx
import { FlowsSlot } from '@flows/react';
```

Render the slot below the existing trial card:

```tsx
return (
  <div className="flex flex-col gap-5">
    {trial && <DashboardTrialCard trial={trial} />}
    <FlowsSlot id="dashboard-onboarding" />
    {/* rest unchanged */}
  </div>
);
```

Why below the trial card: the trial card is already the account status/upgrade strip. The
Flows checklist is activation guidance and should not displace the trial state.

`FlowsSlot` renders nothing when no published block targets that slot for the current user,
so no extra conditional is needed.

Dashboard owner config:

| Checklist item | Completion condition |
| --- | --- |
| Add your first ingredient | `hasIngredient = true` |
| Create your first recipe | `recipeCount >= 1` |
| Try AI photo extraction | `hasRunPhotoExtraction = true` |
| Review your break-even | Link/click completion or later property if a stable event exists |
| Pick a plan before day 14 | Link to pricing/billing surface |

Targeting recommendation for v1:

- `source = trial`
- `role = manager`
- not completed/dismissed

---

## 7. Manual Start Triggers

Use `startWorkflow()` only for celebratory or next-step moments, not for canonical state.

### Recipe Created

File to edit: `components/app/recipes/recipe-list.tsx`.

After `createRecipeAction(...)` returns `result.ok`, fire:

```tsx
void startWorkflow('first-recipe-created').catch(() => undefined);
```

Keep the existing navigation/toast behavior unchanged. Do not `await` Flows before
`router.push`.

The dashboard workflow frequency and property targeting must prevent repeated annoyance.
The checklist still completes from `recipeCount >= 1`, so recipes created through imports
or other future paths are not missed.

### Photo Extraction Done

File to edit: `app/(app)/recipes/import/photo/photo-workbench.tsx`.

Fire after `/api/recipes/import/photo` returns a successful extraction draft and the UI has
accepted it, near the existing success path that calls `setDraft(result)` and
`onSuccessfulExtraction()`.

```tsx
void startWorkflow('first-photo-extraction-done').catch(() => undefined);
```

Do not fire from the staging/confirm route unless the owner explicitly changes the event
meaning from "photo extraction succeeded" to "recipe import completed".

---

## 8. Owner Dashboard Work

The code does not create workflows. The owner must configure these in
`https://app.flows.sh` after the code is deployed to an environment with the correct
organization/environment id.

Owner tasks:

- Create a block targeting slot `dashboard-onboarding`.
- Use component key `PrepProfitChecklist` or `PrepProfitCard`.
- Target `source = trial` and `role = manager` for v1.
- Configure checklist completion from the properties in Section 6.
- Create optional manual-start workflows with keys:
  - `first-recipe-created`
  - `first-photo-extraction-done`
- Set frequency to once per user or once per org-equivalent segment, depending on what the
  Flows dashboard supports. If only once per user is available, use property targeting so
  repeated starts quickly no-op after activation.

---

## 9. Tests And Verification

Required before merge:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

Focused tests:

- Unit/data tests for `getActivationSnapshot()` as listed in Section 4.
- Existing `tests/trial-view.test.ts` and `tests/ai-usage.test.ts` must still pass.
- Typecheck must prove `FlowsSlot id="dashboard-onboarding"` is used correctly.

Manual QA:

- With `NEXT_PUBLIC_FLOWS_ORGANIZATION_ID` unset, the app renders normally and no Flows
  provider crashes.
- With Flows configured, a manager in trial sees the dashboard slot when a matching
  published block exists.
- A kitchen user does not see manager-only trial/onboarding surfaces in v1.
- Creating a recipe does not wait on Flows and still navigates normally.
- Successful photo extraction does not wait on Flows and still decrements/updates the
  existing AI usage surfaces correctly.
- In the Flows debug panel, the current user shows the properties from Section 2 with
  correct values.

---

## 10. Implementation Order

1. Move provider placement and add `user` prop support in `app/flows.tsx`.
2. Add `lib/data/activation.ts` plus tests.
3. Pass the activation/trial/entitlement payload from `app/(app)/layout.tsx`.
4. Add custom components under `components/app/flows/` and register them.
5. Add `<FlowsSlot id="dashboard-onboarding" />` to the dashboard.
6. Add non-blocking `startWorkflow()` calls on the two success paths.
7. Run the full verification gate.
8. Owner configures/publishes the Flows dashboard blocks.

---

## 11. Out Of Scope For This Plan

- New DB migrations.
- Reworking Clerk billing, reverse-trial rules, or plan tier names.
- Replacing `DashboardTrialCard`, `TrialTopBanner`, or the sidebar AI meter.
- Sending financial, recipe, ingredient, customer, or email data to Flows.
- Tours/surveys theming. Keep `tourComponents` and `surveyComponents` on library defaults
  until a real tour/survey is adopted.
- Kitchen-user onboarding slot. Add a separate `recipes-onboarding` slot later if the owner
  wants kitchen activation.
