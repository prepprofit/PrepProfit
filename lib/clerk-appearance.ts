import type { ComponentProps } from 'react';
import type { UserButton } from '@clerk/nextjs';

type ClerkAppearance = NonNullable<
  ComponentProps<typeof UserButton>['appearance']
>;

/**
 * Theme Clerk's prebuilt components (UserButton, OrganizationSwitcher, auth
 * pages) with PrepProfit's tokens — without pulling in `@clerk/themes`. Values
 * mirror the semantic tokens in `app/globals.css`; pass the resolved theme so it
 * tracks the light/dark toggle. `colorPrimary` uses accent-700 so white-on-orange
 * stays at WCAG AA.
 */
export function clerkAppearance(isDark: boolean): ClerkAppearance {
  return {
    variables: {
      colorPrimary: '#c2410c',
      colorPrimaryForeground: '#ffffff',
      colorBackground: isDark ? '#161618' : '#ffffff',
      colorForeground: isDark ? '#fafafa' : '#0f172a',
      colorMutedForeground: isDark ? '#a1a1aa' : '#64748b',
      colorInput: isDark ? '#1f1f23' : '#ffffff',
      colorInputForeground: isDark ? '#fafafa' : '#0f172a',
      colorBorder: isDark ? '#262629' : '#e2e8f0',
      colorNeutral: isDark ? '#fafafa' : '#0f172a',
      colorRing: '#f97316',
      borderRadius: '0.625rem',
      fontFamily: 'var(--font-inter), ui-sans-serif, system-ui, sans-serif',
    },
  };
}
