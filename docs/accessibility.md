# Accessibility & mobile review (Sprint 5f)

A focused review of the core workflows at ~380px and keyboard-only. The app was
already built with the design-taste/impeccable conventions, so this pass verified
the key properties and closed one concrete gap rather than rewriting working UI.

## Verified

- **App shell / navigation** (`components/app/app-shell.tsx`, `top-bar.tsx`,
  `sidebar.tsx`): persistent rail at `lg+`, a slide-in **drawer** below `lg` with
  `role="dialog"` + `aria-modal`, Escape-to-close, click-scrim-to-close, body-scroll
  lock, and focus restore to the trigger on close.
- **Icon-only controls** all carry an `aria-label` (hamburger, search, notifications,
  theme toggle) and a visible `focus-visible:ring`. Theme toggle also has `sr-only` text.
- **Forms** use `<Label htmlFor>` bound to inputs (settings, business identity, the new
  Data & privacy controls); error/success messages use `role="alert"` / `role="status"`.
- **Tables** (ingredients, inventory, payroll, recipe editor) wrap in `overflow-x-auto`,
  so wide grids scroll horizontally instead of breaking the mobile layout.
- **Hit targets**: top-bar controls are `size-9` (36px), buttons are `rounded-full` with
  comfortable padding — at/above the ~40px comfortable-touch guidance.
- **Color**: a unified money-color rule (income emerald / expense neutral / loss red,
  never accent-orange) and theme tokens carry through light/dark.

## Fixed this pass

- The mobile navigation drawer (`role="dialog"`) had **no accessible name** — added
  `aria-label` (`topbar.menuTitle` → "Navigation menu") so screen readers announce it.

## Known limitations (tracked, not launch-blocking)

- The drawer manages focus on open/close + Escape but does **not** trap Tab focus inside
  while open. Escape and scrim-click mitigate; a full focus trap is a follow-up.
- The top-bar **notifications bell** is a visual placeholder with no action yet; it is
  keyboard-focusable. Wire it up or remove it when notifications ship.
- Automated checks (axe) and a screen-reader pass on each page are recommended as part of
  the Playwright E2E expansion (Sprint 5b follow-up).

## How to re-check

- Resize a desktop browser to ~380px (or device emulation) and walk: dashboard → recipes →
  add a recipe → financials → invoices → settings.
- Unplug the mouse: Tab through each page, open ⌘K search, open the mobile drawer, submit a
  form — confirm focus is always visible and nothing is keyboard-trapped.
