'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '@clerk/nextjs';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

/**
 * Browser-side PostHog: pageviews, autocapture, session replay, web vitals —
 * everything the JS SDK ships by default. No-op until NEXT_PUBLIC_POSTHOG_KEY
 * is set (same fail-open contract as the server-side seam in lib/analytics).
 * Identified with the Clerk user id + org group so browser sessions line up
 * with the server-side business events — ids only, never PII.
 */
export function PostHogInit() {
  const { userId, orgId } = useAuth();

  useEffect(() => {
    if (!KEY || posthog.__loaded) return;
    // First-party reverse proxy (see rewrites in next.config.ts) so adblockers
    // don't drop events; ui_host keeps toolbar/replay links on the real region.
    posthog.init(KEY, {
      api_host: '/ingest',
      ui_host: 'https://us.posthog.com',
      defaults: '2026-05-30',
    });
  }, []);

  useEffect(() => {
    if (!KEY) return;
    if (userId) {
      posthog.identify(userId);
      if (orgId) posthog.group('organization', orgId);
    } else if (posthog._isIdentified()) {
      // Sign-out: drop the identity so the next visitor on this browser
      // doesn't inherit the previous user's profile.
      posthog.reset();
    }
  }, [userId, orgId]);

  return null;
}
