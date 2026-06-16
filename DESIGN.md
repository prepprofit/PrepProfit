# PrepProfit Design System & UI Guidelines

Design specifications, color tokens, typography, and component rules for the
**PrepProfit SaaS**. The target look is a **modern productivity dashboard**
(reference: a "HorizonHub"-style app — dark-first, elevated cards, grouped
sidebar, orange accent, data-dense charts). We copy the **visual language**, not
the reference's information architecture: it maps onto PrepProfit's own modules
(Recipes, Ingredients, Inventory, Break-even, Payroll, Invoices).

> **Two themes are first-class: light AND dark.** Light is the default; a toggle
> lets users switch to dark (and system). Every token below has a value for both
> themes.

---

## 1. Theming strategy

- **`next-themes`**, class-based: `.dark` on `<html>` (`attribute="class"`),
  `defaultTheme="light"`, `enableSystem`. Toggle lives in the top bar.
- Colors are **semantic CSS variables** that change per theme; Tailwind v4 maps
  them to utilities (`bg-background`, `bg-surface`, `text-foreground`,
  `border-border`, …) via `@theme inline`.
- Tailwind v4 class-based dark variant: add
  `@custom-variant dark (&:where(.dark, .dark *));` in `globals.css`.

---

## 2. Color tokens

### Brand & accent scales (theme-independent)

`accent` = **Orange** — primary actions, active nav, primary chart series, the
"running timer" affordance. Matches the reference's main accent.

```
--color-accent-50:#fff7ed --color-accent-100:#ffedd5 --color-accent-200:#fed7aa
--color-accent-300:#fdba74 --color-accent-400:#fb923c --color-accent-500:#f97316
--color-accent-600:#ea580c --color-accent-700:#c2410c --color-accent-800:#9a3412
--color-accent-900:#7c2d12
```
Primary action color: solid CTAs use `accent-700` + white text (WCAG AA, 4.5:1;
`accent-500`/`accent-600` + white fail at ~2.3–3.6:1). The brighter `accent-500`
is reserved for **non-text** accents: active nav marker, icons, chart series,
focus ring, glow.

`brand` = **Emerald** — reserved for **profit / positive / success** (e.g. "+12%"
deltas, margin in the green, completed states). This keeps PrepProfit's
"profit = green" semantic, which is ideal for a finance product.

```
--color-brand-50:#effdf4 --color-brand-100:#d9fbe6 --color-brand-200:#b5f5d1
--color-brand-300:#7decb5 --color-brand-400:#3fda91 --color-brand-500:#1abf73
--color-brand-600:#109b5a --color-brand-700:#0f7a49 --color-brand-800:#10603d
--color-brand-900:#0e4f33
```

**Chart categorical palette** (use in this order for multi-series charts & rings):
```
--color-chart-1:#f97316  /* orange  */
--color-chart-2:#10b981  /* emerald */
--color-chart-3:#8b5cf6  /* violet  */
--color-chart-4:#14b8a6  /* teal    */
--color-chart-5:#3b82f6  /* blue    */
--color-chart-6:#f59e0b  /* amber   */
```
Semantic: red `#ef4444` (negative/loss), amber `#f59e0b` (warning/low stock).

### Semantic tokens (theme-aware)

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--background` | `#f8fafc` | `#0a0a0b` | app background |
| `--surface` | `#ffffff` | `#161618` | cards / panels |
| `--surface-2` | `#f1f5f9` | `#1f1f23` | insets, chart bg, hover |
| `--border` | `#e2e8f0` | `#262629` | borders / dividers |
| `--foreground` | `#0f172a` | `#fafafa` | primary text / numbers |
| `--muted-foreground` | `#64748b` | `#a1a1aa` | secondary text |
| `--ring` | `#f97316` | `#f97316` | focus ring (accent) |

---

## 3. `app/globals.css` (Tailwind v4) — implementation

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
  --font-display: var(--font-space-grotesk), ui-sans-serif, system-ui, sans-serif;

  /* accent (orange) + brand (emerald) + chart-* scales here (see section 2) */
}

:root {
  --background:#f8fafc; --surface:#ffffff; --surface-2:#f1f5f9;
  --border:#e2e8f0; --foreground:#0f172a; --muted-foreground:#64748b; --ring:#f97316;
}
.dark {
  --background:#0a0a0b; --surface:#161618; --surface-2:#1f1f23;
  --border:#262629; --foreground:#fafafa; --muted-foreground:#a1a1aa; --ring:#f97316;
}

/* Expose semantic vars as Tailwind color utilities (bg-background, text-foreground, …) */
@theme inline {
  --color-background: var(--background);
  --color-surface: var(--surface);
  --color-surface-2: var(--surface-2);
  --color-border: var(--border);
  --color-foreground: var(--foreground);
  --color-muted-foreground: var(--muted-foreground);
  --color-ring: var(--ring);
}

body { @apply bg-background text-foreground antialiased; }
```

Stop hardcoding `bg-white` / `bg-slate-50` / `text-slate-900` in components — use
the semantic utilities so both themes work automatically. (Existing Sprint 0
components will be migrated to these tokens.)

---

## 4. Color usage rules

- **Orange (`accent`)**: primary buttons/CTAs, active sidebar item, primary chart
  series, the timer/play control, the avatar ring.
- **Emerald (`brand`)**: positive deltas, profit/margin in the green, completed
  badges, success. Never use orange to signal "good number" — that's green's job.
- **Charts**: follow the categorical palette order. Rings (work-activity style)
  use chart-1..3; area/step charts use an orange gradient fill over `surface-2`.
- **Badges**: positive → `bg-brand-50 text-brand-600` (light) / tinted in dark;
  warning → amber; negative → red.

---

## 5. Typography

- **Display**: **Outfit** — `h1`/`h2`, module titles, large financial values
  (`--font-display`). A free, geometric stand-in for Google Sans.
- **Body**: **Roboto** — UI, lists, descriptions (`--font-sans`); the Android
  system font, for a Google-product feel.
- Already wired in `app/layout.tsx` via `next/font` variables.

---

## 6. Layout & components (match the reference)

**App shell**
- **Sidebar**: grouped with small uppercase section labels (reference uses
  "Management / Interaction / Payment"). For PrepProfit, group as:
  *Operations* (Dashboard, Recipes, Ingredients, Inventory) ·
  *Finance* (Break-even, Invoices) · *Team* (Payroll). Logo + product name at
  top; OrganizationSwitcher (workspace) pinned at the bottom. Active item:
  surface chip + orange icon/text + left accent marker.
- **Top bar**: page title/context on the left; on the right: theme toggle,
  notifications, and the Clerk `UserButton`. (A timer/project selector like the
  reference is out of scope — it's HorizonHub-specific.)

**Responsiveness** (mobile-first)
- Sidebar: persistent rail at `lg+`; below `lg` it collapses into a **drawer**
  opened by a hamburger in the top bar (overlay + backdrop).
- Card grids: 3-up at `xl`, 2-up at `md`, 1-up on mobile. Charts shrink, never
  overflow. Tables scroll horizontally inside their card on small screens.

**Cards & surfaces**
- `rounded-xl`, `bg-surface`, `border border-border`, `shadow-sm`. Floating
  elements (toasts, popovers) get `shadow-xl`. Generous padding (`p-5/p-6`).
- **Glass** card variant (frosted: `bg-glass` + `border-glass-border` +
  `backdrop-blur`) for floating / highlighted tiles; light mode keeps a high
  opacity so text stays readable. **Glow** (`shadow-glow`) for accent-highlighted
  surfaces. Both tokens are defined in `app/globals.css`.

**Data viz (built with real data in Sprint 2; mock visually now)**
- Bar chart (Time-tracked style): rounded-top bars, one highlighted series in
  orange, rest muted.
- Area/step chart (KPI style): orange gradient fill on `surface-2`.
- Concentric **activity rings** (Work-activity style): chart-1..3.
- **Segmented progress bar** (Task-overview style): multi-color segments.
- **Completion ring + %** (Project-progress style).

**Controls**
- Buttons: pill (`rounded-full`); primary = orange, plus `outline` and `ghost`.
- Inputs/selects: `surface-2` bg, `border`, focus `ring` (orange).

---

## 7. Assets & brand
- Logo: full wordmark in `public/logo.webp` (light mode) and
  `public/logo-white.webp` (dark mode), swapped via the `dark:` variant. The
  square icon mark lives in `app/icon.png` / `app/apple-icon.png` (favicon).

---

## 8. Dependencies
- **`next-themes`** — light/dark switching. **Added.**
- Charts are **deferred to Sprint 2**: the dashboard ships styled placeholders
  now (see §9). **Decided (2026-06-16): shadcn/ui charts on Recharts** — it is
  literally shadcn + Recharts, themes off our existing CSS-variable tokens, and
  fits Tailwind v4 (no `tailwind.config` preset). Tremor was dropped (React 19
  peer friction + Tailwind-v3 config dependency).
- Icons: `lucide-react` (already installed).

## 9. Scope note
This doc defines the **design language**. The dashboard's data-driven charts need
the financial tables from **Sprint 2**, so during the design phase we build the
shell, theming, responsive layout, and styled components — with **mocked visuals**
on the dashboard — then wire real data in the corresponding sprints.
