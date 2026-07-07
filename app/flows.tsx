'use client';

import { Component, type ReactNode } from 'react';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { FlowsProvider } from '@flows/react';
import * as components from '@flows/react-components';
import * as tourComponents from '@flows/react-components/tour';
import * as surveyComponents from '@flows/react-components/survey';
import '@flows/react-components/index.css';
import * as ppComponents from '@/components/app/flows';
import { logError } from '@/lib/observability';

const ORGANIZATION_ID = process.env.NEXT_PUBLIC_FLOWS_ORGANIZATION_ID;
const ENVIRONMENT = process.env.NEXT_PUBLIC_FLOWS_ENVIRONMENT ?? 'production';

/**
 * The Flows SDK opens a bare `new WebSocket(...)` for live block updates with
 * no try/catch. On iOS WebKit (Lockdown Mode, some content blockers) the
 * constructor itself throws a synchronous SecurityError ("The operation is
 * insecure."), which — because FlowsProvider wraps the whole authenticated
 * app — propagates all the way to the root error boundary and crashes the
 * entire app for what should only ever disable onboarding widgets.
 *
 * This boundary contains that failure to the Flows subtree: the app renders
 * normally without onboarding/tour/survey blocks instead of a global crash.
 */
class FlowsErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    logError({ action: 'flows-provider-error' }, error);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/**
 * Server-derived onboarding/activation properties for Flows targeting. Only COARSE
 * product state — never names, emails, recipe/ingredient names, or money (see the plan
 * §2 and CLAUDE.md AI/data rules). The authenticated app layout computes these once and
 * passes them down; the Clerk identity (`userId`, `clerkOrgId`) is merged in below.
 */
export type FlowsUserProperties = {
  /** PrepProfit app role: `manager` or `kitchen`. */
  role: string;
  /** Entitlement source: `trial`, `paid`, `free`, or `comped`. */
  source: string;
  /** Effective plan tier: `starter`, `solo`, `pro`, or `business`. */
  tier: string;
  /** Convenience flag for dashboard targeting (`source === 'trial'`). */
  isTrial: boolean;
  /** Whole days left while the trial is active; `null` outside a trial. */
  trialDaysLeft: number | null;
  /** Count of active, non-trashed recipes for the active org. */
  recipeCount: number;
  /** Active org has at least one active, non-trashed ingredient. */
  hasIngredient: boolean;
  /** Active org has at least one lifetime succeeded photo extraction. */
  hasRunPhotoExtraction: boolean;
};

export default function Flows({
  children,
  user,
}: {
  children: ReactNode;
  user?: FlowsUserProperties;
}) {
  const { userId, orgId } = useAuth();

  // No org id configured (e.g. local/preview without Flows) — render the app
  // untouched. No point mounting the provider without a target organization.
  if (!ORGANIZATION_ID) return <>{children}</>;

  return (
    <FlowsErrorBoundary fallback={children}>
      <FlowsProvider
        organizationId={ORGANIZATION_ID}
        environment={ENVIRONMENT}
        // Clerk user id. `null` while auth is loading or signed out — the SDK
        // stays disabled (and renders children) until a real user id arrives.
        userId={userId ?? null}
        // Segment/target flows per tenant + the server-derived activation state.
        userProperties={{
          ...(orgId ? { clerkOrgId: orgId } : {}),
          ...user,
        }}
        // PrepProfit-styled blocks override the library defaults by key; the defaults
        // stay registered so existing/default dashboard blocks still render.
        components={{ ...components, ...ppComponents }}
        tourComponents={{ ...tourComponents }}
        surveyComponents={{ ...surveyComponents }}
        LinkComponent={Link}
      >
        {children}
      </FlowsProvider>
    </FlowsErrorBoundary>
  );
}
