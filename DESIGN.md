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

`accent` = **Blue-leaning teal** (hue ~185°) — primary actions, active nav,
selected controls, links, focus. Adopted 2026-09-25, replacing the mint/green
teal, following a Holvi-referenced restyle: pale cyan highlights, deep teal
primary, quiet neutral surfaces.

```
--color-accent-50:#edfafb --color-accent-100:#d7f1f4 --color-accent-200:#bfe8f2
--color-accent-300:#8ad3de --color-accent-400:#4fb8c4 --color-accent-500:#1d98a0
--color-accent-600:#0f7d7e --color-accent-700:#096567 --color-accent-800:#0a4f50
--color-accent-900:#0b3b3c --color-accent-950:#062627
```
**Filled controls use the deep teal with WHITE text** — dark text on this teal
fails contrast. Tokens: `--color-primary:#0f7d7e`, `--color-primary-hover:#096567`,
`--color-primary-soft:#bfe8f2` (pale cyan — selected nav in light mode, soft
secondary surfaces), `--color-primary-foreground:#ffffff` (≈4.9:1 on primary),
`--color-primary-soft-foreground:#07566a` (≈8:1 on the soft chip). Use
`bg-primary text-primary-foreground` for solid fills and `bg-primary-soft
text-primary-soft-foreground` for pale chips — never mix the two foregrounds
with the other background. **Accent text** (links, active labels) uses
`accent-700` on light grounds (≈6.8:1) and `accent-300`/`400` on dark grounds.
Switch tracks use `accent-600` so the white thumb stays visible. Exceptions that
need a deep accent under white or on white: Clerk (`colorPrimary`, it derives
link colours from it), PDFs and email text (`accent-700`).

`brand` = **Leaf green** (hue ~142°) — reserved for **profit / positive / success**.
It is deliberately yellower than the mint accent so an ordinary green button never
reads as "profitable"; results always carry a label too, never colour alone.

```
--color-brand-50:#f0fdf4 --color-brand-100:#dcfce7 --color-brand-200:#bbf7d0
--color-brand-300:#86efac --color-brand-400:#4ade80 --color-brand-500:#22c55e
--color-brand-600:#16a34a --color-brand-700:#15803d --color-brand-800:#166534
--color-brand-900:#14532d
```

**Chart categorical palette** (use in this order for multi-series charts & rings):
```
--color-chart-1:#4fa895  /* mint (accent) */
--color-chart-2:#3b82f6  /* blue   */
--color-chart-3:#8b5cf6  /* violet */
--color-chart-4:#f59e0b  /* amber  */
--color-chart-5:#ec4899  /* pink   */
--color-chart-6:#64748b  /* slate  */
```
Finance series: income = `brand-600`, expense = amber (`chart-4`), profit = blue
(`chart-2`) — never the accent.
Semantic: red `#ef4444` (negative/loss), amber `#f59e0b` (warning/low stock).

### Semantic tokens (theme-aware)

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--background` | `#f5f7fa` | `#0a0a0b` | app / sidebar background |
| `--surface` | `#ffffff` | `#161618` | cards / panels |
| `--surface-2` | `#eef2f6` | `#1f1f23` | insets, chart bg, hover |
| `--border` | `#dfe6eb` | `#262629` | borders / dividers |
| `--foreground` | `#292f3a` | `#fafafa` | primary text / numbers |
| `--muted-foreground` | `#40516a` | `#a1a1aa` | secondary text, nav icons |
| `--ring` | `#0f7d7e` | `#4fb8c4` | focus ring (accent) |

Dark mode keeps its own neutral scale rather than reusing the light values —
only the accent-derived tokens (`--ring`, `--color-primary*`) shift with the
rebrand; `--background`/`--surface`/`--border`/`--foreground` stay the existing
near-black palette so dark mode stays legible on its own terms.

---

## 3. `app/globals.css` (Tailwind v4) — implementation

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --font-sans: var(--font-roboto), ui-sans-serif, system-ui, sans-serif;
  --font-display: var(--font-outfit), ui-sans-serif, system-ui, sans-serif;

  /* accent (teal) + primary + brand (leaf green) + chart-* scales here (see section 2) */
}

:root {
  --background:#f5f7fa; --surface:#ffffff; --surface-2:#eef2f6;
  --border:#dfe6eb; --foreground:#292f3a; --muted-foreground:#40516a; --ring:#0f7d7e;
}
.dark {
  --background:#0a0a0b; --surface:#161618; --surface-2:#1f1f23;
  --border:#262629; --foreground:#fafafa; --muted-foreground:#a1a1aa; --ring:#4fb8c4;
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

- **Teal (`accent` / `primary`)**: primary buttons/CTAs (deep teal fill, white
  text), active sidebar item (pale cyan chip, dark teal text), selected
  chips/tabs, step badges, links, focus. One primary action per screen.
- **Leaf green (`brand`)**: positive deltas, profit/margin in the green, completed
  badges, success. Never use the teal accent to signal "good number".
- **Charts**: follow the categorical palette order. Rings use chart-1..3; area/step
  charts use a teal gradient fill over `surface-2`.
- **Badges**: positive → `bg-brand-50 text-brand-600` (light) / tinted in dark;
  warning → amber; negative → red.

---

## 5. Typography

- **Display**: **Outfit** — `h1`/`h2`, module titles, large financial values
  (`--font-display`). A free, geometric stand-in for Google Sans.
- **Body**: **Roboto** — UI, lists, descriptions (`--font-sans`); the Android
  system font, for a Google-product feel.
- **Title weight is always `font-semibold` (600).** Every display title/heading —
  `h1`–`h4`, section titles, card titles — uses weight 600 across **both**
  marketing and dashboard. Never `font-bold` (700), `font-medium` (500), or
  `font-extrabold` (800) on a title. (Small uppercase eyebrow/micro-labels are
  not titles and may stay `font-medium`; large numeric stat values keep their
  own display weight.)
- Only two fonts exist in the whole project: **Outfit** (display) and **Roboto**
  (body). Do not introduce a third.
- Already wired in `app/layout.tsx` via `next/font` variables.

---

## 6. Layout & components (match the reference)

**App shell**
- **Sidebar**: grouped with small uppercase section labels (reference uses
  "Management / Interaction / Payment"). For PrepProfit, group as:
  *Operations* (Dashboard, Recipes, Ingredients, Inventory) ·
  *Finance* (Break-even, Invoices) · *Team* (Payroll). Logo + product name at
  top; OrganizationSwitcher (workspace) pinned at the bottom. Active item:
  pale cyan chip + dark teal text/icon (light); solid teal pill + white
  text/icon (dark).
- **Top bar**: page title/context on the left; on the right: theme toggle,
  notifications, and the Clerk `UserButton`. (A timer/project selector like the
  reference is out of scope — it's HorizonHub-specific.)

**Responsiveness** (mobile-first)
- Sidebar: persistent rail at `lg+`; below `lg` it collapses into a **drawer**
  opened by a hamburger in the top bar (overlay + backdrop).
- Card grids: 3-up at `xl`, 2-up at `md`, 1-up on mobile. Charts shrink, never
  overflow. Tables scroll horizontally inside their card on small screens.

**Cards & surfaces**
- `rounded-2xl`, `bg-surface`, `border border-border`, `shadow-sm`. Floating
  elements (toasts, popovers) get `shadow-xl`. Generous padding (`p-5/p-6`).
- **Glass** card variant (frosted: `bg-glass` + `border-glass-border` +
  `backdrop-blur`) for floating / highlighted tiles; light mode keeps a high
  opacity so text stays readable. **Glow** (`shadow-glow`) for accent-highlighted
  surfaces. Both tokens are defined in `app/globals.css`.

**Data viz (built with real data in Sprint 2; mock visually now)**
- Bar chart (Time-tracked style): rounded-top bars, one highlighted series in
  teal, rest muted.
- Area/step chart (KPI style): teal gradient fill on `surface-2`.
- Concentric **activity rings** (Work-activity style): chart-1..3.
- **Segmented progress bar** (Task-overview style): multi-color segments.
- **Completion ring + %** (Project-progress style).

**Controls**
- Buttons: pill (`rounded-full`, ~36–40px tall); primary = deep teal fill + white
  text, plus `outline` (neutral secondary) and `ghost`.
- Inputs/selects: white `surface` bg, visible `border`, ~6–8px radius, focus
  `ring` (teal 600 / 400 dark).

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
