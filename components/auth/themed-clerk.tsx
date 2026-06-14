'use client';

import { SignIn, SignUp, OrganizationList } from '@clerk/nextjs';
import { useTheme } from 'next-themes';
import { clerkAppearance } from '@/lib/clerk-appearance';

/** Clerk's hosted-UI components, themed to track the light/dark toggle. */

export function ThemedSignIn() {
  const { resolvedTheme } = useTheme();
  return <SignIn appearance={clerkAppearance(resolvedTheme === 'dark')} />;
}

export function ThemedSignUp() {
  const { resolvedTheme } = useTheme();
  return <SignUp appearance={clerkAppearance(resolvedTheme === 'dark')} />;
}

export function ThemedOrganizationList() {
  const { resolvedTheme } = useTheme();
  return (
    <OrganizationList
      hidePersonal
      afterCreateOrganizationUrl="/dashboard"
      afterSelectOrganizationUrl="/dashboard"
      appearance={clerkAppearance(resolvedTheme === 'dark')}
    />
  );
}
