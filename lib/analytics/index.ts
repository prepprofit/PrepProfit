import { analyticsEnv } from '@/lib/env';
import type { AnalyticsEvent, AnalyticsProperties } from './events';

export type { AnalyticsEvent, AnalyticsProperties } from './events';

/**
 * Product analytics seam (Sprint 5c). The app captures a small allowlist of
 * business events through this interface, never a vendor SDK directly, so tests
 * inject a recording fake and the call sites stay decoupled. The default client
 * posts to PostHog's HTTP capture endpoint (no SDK dependency, no batching/flush
 * lifecycle to get wrong in serverless) and is FAIL-OPEN: when PostHog is not
 * configured it is a no-op, and {@link trackEvent} swallows any error so analytics
 * can never break a request. No PII or money is ever sent (see `events.ts`).
 */
export type CaptureInput = {
  event: AnalyticsEvent;
  /** Org the event belongs to — sent as a PostHog group, never as PII. */
  orgId: string;
  /** Acting user id (used only as the distinct id); falls back to the org. */
  userId?: string | null;
  properties?: AnalyticsProperties;
};

export interface AnalyticsClient {
  capture(input: CaptureInput): Promise<void>;
}

/** Builds the active analytics client — PostHog when configured, else a no-op. */
export function getAnalytics(): AnalyticsClient {
  const cfg = analyticsEnv();
  if (!cfg) return { async capture() {} };

  return {
    async capture(input: CaptureInput): Promise<void> {
      await fetch(`${cfg.host}/capture/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: cfg.key,
          event: input.event,
          // No user id → bucket by org so events still attribute to a tenant.
          distinct_id: input.userId ?? `org:${input.orgId}`,
          properties: {
            ...input.properties,
            // Group analytics by tenant without leaking the org into the distinct id.
            $groups: { organization: input.orgId },
          },
        }),
        // Never let a slow/blocked analytics endpoint hang a user action.
        signal: AbortSignal.timeout(2000),
      });
    },
  };
}

/**
 * Best-effort capture for a post-success call site. Awaits delivery (tight timeout)
 * so serverless doesn't drop it, but swallows every error — analytics is never
 * load-bearing. Use ONLY after the real work has committed.
 */
export async function trackEvent(input: CaptureInput): Promise<void> {
  try {
    await getAnalytics().capture(input);
  } catch {
    // Fail-open: a capture failure must never affect the request.
  }
}
