# Plan - Reverse-trial UI surfaces

**Status:** SENIOR-REVIEWED implementation plan - ready for dev.
**Reviewed:** 2026-07-03.
**Scope:** UI surfaces, server read-model helpers, i18n, and tests only. No DB schema,
Clerk catalogue, billing webhook, cron, quota-cap, or entitlement-enforcement changes.

---

## 0. Review verdict

The original direction is approved, but the draft was not implementation-ready as written.
This revision closes the repo-specific gaps:

- The dashboard hero cannot reuse a value that only lives inside `AppShell`; use a cached
  server helper so `layout.tsx` and `dashboard/page.tsx` agree without duplicating logic.
- Do not pass a server component as a sidebar footer slot. `Sidebar` owns `collapsed` and
  `onNavigate`, so the meter must be rendered from serializable data inside the client
  sidebar.
- Do not call `getAiUsageThisMonth()` for a one-row sidebar meter. The repo already has a
  cheaper photo-extraction usage path; extend that read model instead of loading every AI
  feature on every navigation.
- Do not add React Testing Library requirements unless the dependency is explicitly added.
  The current test stack is Vitest in `node` plus Playwright E2E.
- Do not say "all locales"; today there is only `lib/i18n/messages/en.json`.

---

## 1. Verified current code facts

- `app/(app)/layout.tsx` is the app chrome server entry. It currently resolves
  `getUserRole()` and passes only `canSeeFinance={canAccessFinancials(role)}` into
  `AppShell`.
- `components/app/app-shell.tsx` is a client component. It renders one desktop `Sidebar`,
  one mobile-drawer `Sidebar`, `TopBar`, `<main>`, and `CommandPalette`.
- `components/app/sidebar.tsx` is a client component. It owns `collapsed`, active route
  state, footer rendering, and `onNavigate` for mobile drawer close behavior.
- `components/app/sidebar.tsx` footer is manager-only for Trash/Import and is hidden for a
  kitchen user on the collapsed rail.
- `app/(app)/dashboard/page.tsx` is manager-only. Kitchen users redirect to `/recipes`; a
  not-onboarded manager redirects to `/onboarding` before the dashboard content renders.
- `/billing` and `/pricing` are manager-only. `/pricing` renders Clerk's
  `<PricingTable for="organization" />`.
- `getEffectiveEntitlementState()` in `lib/entitlements.ts` already returns
  `{ tier, source, trialEndsAt }`; active reverse trial is `source === 'trial'`; it reads
  the `org_trial_ends_at` session claim and performs no DB read.
- `trialReminderDaysLeft(end, now)` already implements UTC calendar-day math. It can return
  negative values, so UI helpers must clamp for display.
- `getAiUsageThisMonth()` reads all metered AI features via one `withOrg` transaction.
- `getPhotoExtractionUsageThisMonth()` already exists and reads only photo extraction usage.
  Add a small summary variant for the sidebar rather than loading all feature rows.
- `lib/i18n/messages/en.json` is the only app locale file today. Existing billing copy lives
  under `billing.trial` and `billing.aiUsage`.
- `package.json` has Vitest/Playwright, but no `@testing-library/react` or DOM test
  environment. `vitest.config.ts` uses `environment: 'node'`.
- Lowest paid plan copy is already pinned as Solo `€19` in `marketing.pricing.solo.price`,
  and `tests/billing-catalogue.test.ts` keeps the public pricing copy aligned with the
  committed Clerk catalogue and entitlement constants.

---

## 2. Locked product/technical decisions

1. **Manager-only surfaces.** Dashboard card, top banner, and sidebar meter render only when
   `canSeeFinance` is true. Kitchen users never see checkout or upgrade CTAs.
2. **Active-trial card/banner only.** Dashboard hero and top banner render only for
   `source === 'trial'`. A post-trial "trial ended" banner is out of v1; `/billing` already
   has ended-trial copy and feature gates already surface upgrade prompts.
3. **Sidebar meter is one row.** V1 shows Photo recipe extraction usage only. No aggregate
   credits and no multi-row condensed meter.
4. **Sidebar meter is not a server-component slot.** The server layout fetches a plain
   `SidebarAiMeterView | null`; the client `Sidebar` renders the meter so it can respect
   `collapsed` and call `onNavigate`.
5. **Collapsed sidebar hides the meter in v1.** The expanded desktop rail and mobile drawer
   show it; the icon-only rail keeps its current compact footer behavior.
6. **CTA routing.** Trial/free managers see `Upgrade` -> `/pricing`; paid managers see
   `Manage plan` -> `/billing`; comped orgs show the meter without an upsell CTA.
7. **Banner is persistent.** No dismiss/localStorage in v1. This avoids a new client state
   contract.
8. **Banner exclusions.** Hide the top banner on `/dashboard`, `/billing`, `/pricing`, and
   `/onboarding` including nested paths.
9. **Price label source.** Use `marketing.pricing.solo.price` for the `{price}` interpolation
   instead of duplicating `€19` in a new key. That keeps the existing billing-catalogue test
   as the drift guard.
10. **No promise of full AI volume.** Trial copy must say Business modules are unlocked while
    trial AI uses smaller monthly allowances.

---

## 2.1 Visual parity target

The goal is Zapier-inspired placement and hierarchy, not a pixel clone or Zapier branding.
Use the screenshots as UX references:

- **Dashboard reference (`Zapier main dashboard`).** The trial surface is a compact horizontal
  strip near the top of the dashboard content, not a tall marketing hero. It has:
  - a left day-count tile (`14`) with stacked "TRIAL / DAYS LEFT" label;
  - a short title and one-line support copy in the middle;
  - a right-aligned primary CTA;
  - a subtle tinted background and accent border.
- **Secondary-page reference (`Zapier secondary dashboard`).** The thin trial banner sits above
  the app chrome and spans the full viewport width, including the sidebar/top-bar area. It is
  not just an in-content alert below the top bar.
- **Sidebar reference.** The usage meter lives at the bottom-left footer, above the plan/trial
  management link, with a thin progress bar and compact `used / limit` count.

Adaptation for PrepProfit:

- Use PrepProfit's orange/green design tokens and existing button/card primitives.
- Keep corners, spacing, typography, and colors consistent with the current app.
- Do not add Zapier-specific nav, search, footer, chat bubble, or product shortcuts.
- The dashboard card should feel like a product-status strip inside the dashboard, not a
  landing-page hero.

---

## 3. Target data flow

```txt
app/(app)/layout.tsx (server)
  role = getUserRole()
  canSeeFinance = canAccessFinancials(role)
  trial = canSeeFinance ? await getTrialView() : null
  sidebarAiMeter = canSeeFinance ? await getSidebarAiMeterView() : null
  lowestPaidPrice = canSeeFinance ? tMarketingSolo('price') : ''

  <AppShell
    canSeeFinance={canSeeFinance}
    trial={trial}
    sidebarAiMeter={sidebarAiMeter}
    lowestPaidPrice={lowestPaidPrice}
  >
    {children}
  </AppShell>

app/(app)/dashboard/page.tsx (server)
  existing manager + onboarding guards
  trial = await getTrialView()
  {trial && <DashboardTrialCard trial={trial} />}

components/app/app-shell.tsx (client)
  renders TrialTopBanner above the app chrome so it spans the full viewport width
  forwards sidebarAiMeter to both Sidebar instances

components/app/sidebar.tsx (client)
  if canSeeFinance && !collapsed && sidebarAiMeter
    render SidebarAiMeter with onNavigate
```

Why this shape:

- `getTrialView()` is cached per request, so layout and dashboard can both call it safely.
- The sidebar usage read happens once in the server layout and is reused by both sidebars.
- The meter UI remains client-side where the route-close and collapsed-rail state actually
  live.

---

## 4. New trial view helper

Add `lib/trial.ts`.

```ts
import { cache } from 'react';
import {
  type EffectiveEntitlementState,
  trialReminderDaysLeft,
  getEffectiveEntitlementState,
} from '@/lib/entitlements';

export type TrialView = {
  source: 'trial';
  daysLeft: number;
  endsToday: boolean;
  trialEndsAtIso: string;
};

export function trialDaysLeft(end: Date | null, now: Date): number {
  if (end == null) return 0;
  return Math.max(0, trialReminderDaysLeft(end, now));
}

export function deriveTrialView(
  state: EffectiveEntitlementState,
  now: Date,
): TrialView | null {
  if (state.source !== 'trial' || state.trialEndsAt == null) return null;
  const daysLeft = trialDaysLeft(state.trialEndsAt, now);
  return {
    source: 'trial',
    daysLeft,
    endsToday: daysLeft === 0,
    trialEndsAtIso: state.trialEndsAt.toISOString(),
  };
}

export const getTrialView = cache(async (): Promise<TrialView | null> => {
  return deriveTrialView(await getEffectiveEntitlementState(), new Date());
});
```

Implementation notes:

- Client components may import `TrialView` as a type only.
- Keep all display props serializable; do not pass a `Date` object to `AppShell`.
- The helper intentionally returns `null` for `paid`, `free`, and `comped`.
- Reuse UTC calendar-day semantics from `trialReminderDaysLeft`; clamp only for UI display.

Tests in `tests/entitlements.test.ts` or a new `tests/trial-view.test.ts`:

- active trial with 14, 1, and 0 UTC calendar days left.
- expired end date clamps to `0` only when deriving from a forced trial-shaped state.
- `trialEndsAt === null` -> `null`.
- `source` of `paid`, `free`, or `comped` -> `null`.
- `trialEndsAtIso` is an ISO string, not a `Date`.

---

## 5. Sidebar AI meter read model

Extend `lib/data/ai-usage.ts` with a cheap summary for the sidebar.

```ts
export type PhotoExtractionUsageSummary = {
  tier: PlanTier;
  source: EntitlementSource;
  resetAt: Date;
  row: AiUsageRow;
};

export async function getPhotoExtractionUsageSummaryThisMonth(
  now: Date = new Date(),
): Promise<PhotoExtractionUsageSummary> {
  const organizationId = await getOrgId();
  const limits = await allAiMonthlyLimits();
  const monthStart = monthStartUtc(now);
  const counts = await withOrg(organizationId, (tx) =>
    countExtractionUsageSince(tx, organizationId, monthStart, now),
  );
  const photo = limits.photo_recipe_extraction;
  return {
    tier: photo.tier,
    source: photo.source,
    resetAt: nextMonthResetUtc(now),
    row: buildUsageRow('photo_recipe_extraction', counts, photo.limit),
  };
}
```

Add a pure UI view builder in `lib/data/ai-usage.ts`:

```ts
export type SidebarAiMeterView = {
  source: EntitlementSource;
  feature: 'photo_recipe_extraction';
  used: number;
  limit: number;
  remaining: number;
  availableNow: number;
  percent: number;
  cta: null | { labelKey: 'upgrade' | 'managePlan'; href: '/pricing' | '/billing' };
};
```

Rules:

- If `row.limit <= 0`, return `null`.
- `percent = Math.min(100, Math.round((row.used / row.limit) * 100))`.
- `source === 'comped'` returns `cta: null`.
- `source === 'paid'` returns `managePlan` -> `/billing`.
- `source === 'trial'` or `source === 'free'` returns `upgrade` -> `/pricing`.
- Wrap the server read in React `cache()` from the app/layout side, not inside the generic
  data layer, so the desktop and mobile sidebars share one read per request without making
  `lib/data/*` depend on React.

Do not use `getAiUsageThisMonth()` for this v1 meter.

Tests:

- `getPhotoExtractionUsageSummaryThisMonth()` returns `source` and the photo row without
  loading operation-feature rows.
- Sidebar view returns the correct CTA for `trial`, `free`, `paid`, and `comped`.
- Over-cap usage clamps `percent` at 100 and remaining at 0.

---

## 6. Components and wiring

### 6.1 `app/(app)/layout.tsx`

- Import `getTrialView()` and the cached sidebar meter read.
- Resolve `role` once, compute `canSeeFinance` once.
- Only fetch trial/meter/price data when `canSeeFinance` is true; pass an empty
  `lowestPaidPrice` for kitchen because `trial` is `null` and the banner does not render.
- Use `getTranslations('marketing.pricing.solo')` to pass `lowestPaidPrice` into
  `AppShell`.
- Keep the layout dynamic by virtue of Clerk/auth reads; no explicit caching layer outside
  React request cache.

### 6.2 `components/app/app-shell.tsx`

Add props:

```ts
trial: TrialView | null;
sidebarAiMeter: SidebarAiMeterView | null;
lowestPaidPrice: string;
```

Render:

- Restructure the shell to an outer vertical frame:
  - top: `<TrialTopBanner trial={trial} lowestPaidPrice={lowestPaidPrice} />`
  - bottom: the existing horizontal app chrome (`Sidebar` + content column)
- The banner must be `shrink-0` and span the full viewport width like the Zapier secondary
  screenshot; the content column still keeps `TopBar` above `<main>`.
- Forward `sidebarAiMeter` to both `Sidebar` instances.

### 6.3 `components/app/sidebar.tsx`

Add prop:

```ts
sidebarAiMeter?: SidebarAiMeterView | null;
```

Footer order:

1. expanded-only `SidebarAiMeter`
2. Trash
3. Import
4. OrganizationSwitcher

Rules:

- Render the meter only when `canSeeFinance && !collapsed && sidebarAiMeter`.
- Pass `onNavigate` into meter CTA links so the mobile drawer closes after click.
- Preserve the existing `showFooter` behavior for kitchen/collapsed cases.

### 6.4 `components/app/trial/dashboard-trial-card.tsx`

Server component receiving `trial: TrialView`.

Render at the top of `app/(app)/dashboard/page.tsx` after the existing manager and
onboarding guards, before the welcome row.

UI requirements:

- Use existing `Card` and `Button`.
- Use `bg-accent-50` / `dark:bg-accent-500/10` style, not a new palette.
- Match the Zapier-like horizontal strip: one row on desktop, compact height, day-count tile on
  the left, copy in the middle, CTA on the right.
- Show a prominent numeric day count, but use an `endsToday` label when `daysLeft === 0`.
- CTA: `Upgrade now` -> `/pricing`.
- Copy must say Business modules are available and trial AI has smaller monthly allowances.

### 6.5 `components/app/trial/trial-top-banner.tsx`

Client component receiving `trial` and `lowestPaidPrice`.

Rules:

- Return `null` when `trial == null`.
- Use `usePathname()` and hide on `/dashboard`, `/billing`, `/pricing`, `/onboarding`, and
  nested paths.
- Persistent for v1; no dismiss button.
- Layout: thin full-width strip above the app shell, with an info icon, bold welcome label,
  one concise sentence, and an inline `Upgrade` link/button. This should resemble the Zapier
  secondary-page banner placement while using PrepProfit tokens.

### 6.6 `components/app/trial/sidebar-ai-meter.tsx`

Client/presentational component receiving:

```ts
view: SidebarAiMeterView;
onNavigate?: () => void;
```

Rules:

- Use `billing.aiUsage.features.photo_recipe_extraction`, `billing.aiUsage.used`, and
  `billing.aiUsage.remaining` for labels.
- Use new `trial.sidebar.title`, `trial.sidebar.upgrade`, and
  `trial.sidebar.managePlan` for the wrapper/CTA.
- Use a progressbar with `aria-valuenow`, `aria-valuemin`, and `aria-valuemax`.
- Keep the component visually compact; it lives in a 256px sidebar footer.

---

## 7. i18n

Edit only `lib/i18n/messages/en.json` unless new locale files are added before this work.

Add a top-level `trial` namespace:

```jsonc
"trial": {
  "daysLeft": "{days, plural, =0 {Ends today} one {# trial day left} other {# trial days left}}",
  "card": {
    "title": "Business is unlocked for your trial",
    "subtitle": "Use every module now. Trial AI uses smaller monthly allowances; paid plans unlock higher monthly volume.",
    "cta": "Upgrade now"
  },
  "banner": {
    "body": "You have {daysLabel} to try the paid features. Upgrade anytime from {price}/month.",
    "cta": "Upgrade"
  },
  "sidebar": {
    "title": "AI usage this month",
    "managePlan": "Manage plan",
    "upgrade": "Upgrade"
  }
}
```

Notes:

- `daysLabel` is produced with `trial.daysLeft`.
- `{price}` comes from `marketing.pricing.solo.price`; do not duplicate `€19` here.
- Reuse existing `billing.aiUsage.*` for feature label and meter counts.

---

## 8. Test plan

Required:

- Unit tests for `trialDaysLeft()` and `deriveTrialView()`.
- Unit/data tests for `getPhotoExtractionUsageSummaryThisMonth()` and the sidebar meter view
  CTA/percent rules.
- Existing `tests/ai-usage.test.ts` should cover the new photo summary without weakening the
  full billing meter tests.
- `tests/billing-catalogue.test.ts` does not need a new price assertion if the banner reads
  `marketing.pricing.solo.price` directly.
- Add a light pure test for route exclusion if the path-matching helper is extracted from
  `TrialTopBanner`; otherwise cover manually in QA.

Optional, only if the team wants UI automation:

- Playwright authenticated smoke for a manager on trial: dashboard card visible, banner hidden
  on dashboard, banner visible on `/recipes`, hidden on `/billing` and `/pricing`.
- Do not introduce React Testing Library in this slice unless the dependency and DOM test
  environment are explicitly approved.

Before merge:

```txt
npm run lint
npm run typecheck
npm test
npm run build
```

---

## 9. Files touched

New:

- `lib/trial.ts`
- `components/app/trial/dashboard-trial-card.tsx`
- `components/app/trial/trial-top-banner.tsx`
- `components/app/trial/sidebar-ai-meter.tsx`

Edited:

- `lib/data/ai-usage.ts` - add photo extraction summary and sidebar view helper.
- `app/(app)/layout.tsx` - derive manager-only trial/meter/price props.
- `components/app/app-shell.tsx` - accept props, render banner, forward meter.
- `components/app/sidebar.tsx` - render expanded-only meter in footer.
- `app/(app)/dashboard/page.tsx` - render dashboard trial card after guards.
- `lib/i18n/messages/en.json` - add `trial` namespace.
- `tests/entitlements.test.ts` or `tests/trial-view.test.ts` - trial view tests.
- `tests/ai-usage.test.ts` - photo summary/sidebar view tests.

Explicitly not touched:

- DB schema/migrations.
- Clerk `billing.json` or Clerk dashboard configuration.
- `getEffectiveEntitlementState()` precedence rules.
- `resolveAiLimit()` caps.
- Billing/pricing checkout behavior.
- Cron, webhooks, email reminders, or outbox.

---

## 10. Manual QA checklist

Use a manager org with an active reverse trial:

- `/dashboard`: hero card visible at the top; top banner hidden.
- `/recipes` or another non-excluded app page: top banner visible.
- `/billing`, `/pricing`, `/onboarding`: top banner hidden.
- Sidebar expanded: photo extraction meter visible; CTA says `Upgrade` and links to
  `/pricing`.
- Sidebar collapsed: meter hidden; Trash/Import behavior unchanged.
- Mobile drawer: meter visible; tapping its CTA closes the drawer via `onNavigate`.
- Kitchen role: no dashboard, no banner, no sidebar meter, no pricing CTA.
- Paid org: no trial hero/banner; sidebar meter CTA says `Manage plan` and links to
  `/billing`.
- Comped org: no trial hero/banner; sidebar meter has no upsell CTA.

Use a trial ending today:

- Dashboard card and banner use the "Ends today" label, not "0 trial days left".

Use an over-cap AI row:

- Progress bar clamps to 100%; count still shows truthful `used / limit`.

---

## 11. Definition of done

- No hardcoded user-visible strings in components.
- No new DB tables or entitlement semantics.
- No `getAiUsageThisMonth()` call from the sidebar v1 path.
- No server component passed as a footer slot into `Sidebar`.
- All trial/meter props crossing into client components are serializable.
- Manager/kitchen boundary remains cosmetic in chrome and enforced by existing pages/actions.
- Lint, typecheck, unit tests, and build pass.
