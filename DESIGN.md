# PrepProfit Design System & UI Guidelines

This document contains strictly defined design specifications, exact color palettes, typography settings, and UI component guidelines for the **PrepProfit SaaS**.


## 1. Exact Color Palette & Mapping

The app drops common grays (`gray`, `zinc`, `neutral`) in favor of the **Slate** scale for a professional, "cool/clean" Scandinavian aesthetic. A custom **Emerald Green** scale (named `brand`) is used strictly for profits, positive highlights, and CTAs (as seen in the primary button and the "+14%" indicators).

### CSS Variables (add to `app/globals.css` — Tailwind v4)
```css
@theme {
  /* Custom fonts */
  --font-sans: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
  --font-display: var(--font-display), ui-sans-serif, system-ui, sans-serif;

  /* Primary color system (PrepProfit Emerald) */
  --color-brand-50: #effdf4;  /* Subtle background: active menu items, light badge backgrounds */
  --color-brand-100: #d9fbe6; /* Hover states, avatars or highlighted icons */
  --color-brand-200: #b5f5d1;
  --color-brand-300: #7decb5;
  --color-brand-400: #3fda91; /* Contrasting icons and graphics on dark backgrounds */
  --color-brand-500: #1abf73; /* Progress bars, "View Income Statement" button (dark background) */
  --color-brand-600: #109b5a; /* PRIMARY COLOR: "Start 14-day free trial" button, main icon, active text */
  --color-brand-700: #0f7a49; /* Hover for primary buttons */
  --color-brand-800: #10603d;
  --color-brand-900: #0e4f33;
}
```

### Where to apply the colors (faithful to the screenshot/image):
1.  **Backgrounds:**
    *   **Global app background:** `bg-slate-50` (`#f8fafc`). Note how the area around the dashboard cards/sidebar has a continuous very light color — it is not 100% white!
    *   **Main cards and panels:** `bg-white` (`#ffffff`) with divider lines and `border-slate-200` (`#e2e8f0`) borders.
    *   **Dark cards (e.g. Monthly Profit Goal):** `bg-slate-900` (`#0f172a`), using text from `text-slate-300` to `text-white`.
2.  **Text and Typography (Slate scale):**
    *   Prominent titles (e.g. "Financial Overview") and key numbers (e.g. "$24,500"): `text-slate-900`.
    *   Secondary text and list-item descriptions: `text-slate-500` to `text-slate-600`.
3.  **Growth indicators / Badges:**
    *   Use a positive badge with a very light green background and vibrant text: `bg-brand-50 text-brand-600 font-semibold px-2 py-0.5 rounded-full`.
4.  **Sidebar:**
    *   Active (selected) menu item: white rounded shape with a background and border (`bg-white shadow-sm border border-slate-200/60`), using `text-brand-700` on the icon (`LayoutDashboard`) and the main font.
    *   Inactive sidebar links: low-opacity text, `text-slate-600 hover:bg-slate-100`.

## 2. Typography

The interface mixes a modern technical font (Space Grotesk) for reading prominent numbers/headings, and a highly legible sans-serif (Inter) for repetitive UI components.

*   **Display Font**: **Space Grotesk** (used for `h1`, `h2`, module titles, and large financial values).
*   **Body Font**: **Inter** (used for list items, ingredient descriptions, margins). Configured as `--font-sans`.

### Next.js App Router setup (`app/layout.tsx`):
```tsx
import { Inter, Space_Grotesk } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-display' });

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
       <body className="font-sans text-slate-900 bg-slate-50 antialiased" suppressHydrationWarning>
         {children}
       </body>
    </html>
  );
}
```

## 3. Componentization Guidelines (Design Language System)

*   **Interface geometry (borders / radii):**
    *   Large top-bar / landing-page buttons: "pill" shape (`rounded-full`).
    *   Dashboard cards and modular panels: use `rounded-xl` with a delicate light border (`border border-slate-200`).
*   **Depth (shadows):**
    *   Most fixed cards show little or no shadow (`shadow-sm`).
    *   Interactive elements that float over the interface (like simulated toasts and side pop-up bars) get elevated shadows like `shadow-xl border border-slate-200`.
*   **Charts and Icons (Lucide React):**
    *   The `lucide-react` library is explicitly recommended for pictograms — flexible stroke weight and a consistent visual style (key icons: `ChefHat`, `LayoutDashboard`, `BarChart3`, `CircleDollarSign`, `Calculator`, `TrendingUp`, `Package`, `Utensils`).

## 4. Assets and Brand

*   **The company logo (PrepProfit):** the generated logo file is at `public/logo_final.jpg`.
*   In the top nav menu it should be implemented small, next to the name in display text, with `border-radius: 6px` (`rounded-md`), ensuring a premium SaaS consistency.
