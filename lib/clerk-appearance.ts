import type { ComponentProps } from 'react';
import type { UserButton } from '@clerk/nextjs';

type ClerkAppearance = NonNullable<
  ComponentProps<typeof UserButton>['appearance']
>;

/**
 * Theme Clerk's prebuilt components (UserButton, OrganizationSwitcher, auth
 * pages) with PrepProfit's tokens — without pulling in `@clerk/themes`. Values
 * mirror the semantic tokens in `app/globals.css`; pass the resolved theme so it
 * tracks the light/dark toggle. `colorPrimary` is the app's deep teal
 * `--color-primary` — Clerk also derives LINK colours from it, and white text
 * on this teal is ≈4.9:1, readable for both the button fill and links.
 */
export function clerkAppearance(isDark: boolean): ClerkAppearance {
  return {
    // PrepProfit is one organization per customer, so members never create
    // their own orgs — hide the "Create organization" action in the switcher.
    // (Real enforcement is the instance-level org-creation setting in Clerk;
    // this just removes the affordance from the UI.)
    elements: {
      organizationSwitcherPopoverActionButton__createOrganization: {
        display: 'none',
      },
    },
    variables: {
      colorPrimary: '#0f7d7e',
      colorPrimaryForeground: '#ffffff',
      colorBackground: isDark ? '#161618' : '#ffffff',
      colorForeground: isDark ? '#fafafa' : '#292f3a',
      colorMutedForeground: isDark ? '#a1a1aa' : '#40516a',
      colorInput: isDark ? '#1f1f23' : '#ffffff',
      colorInputForeground: isDark ? '#fafafa' : '#292f3a',
      colorBorder: isDark ? '#262629' : '#dfe6eb',
      colorNeutral: isDark ? '#fafafa' : '#292f3a',
      colorRing: isDark ? '#4fb8c4' : '#0f7d7e',
      borderRadius: '0.625rem',
      fontFamily: 'var(--font-roboto), ui-sans-serif, system-ui, sans-serif',
    },
  };
}
