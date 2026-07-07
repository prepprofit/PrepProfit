'use client';

import { useEffect, useSyncExternalStore } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '@clerk/nextjs';
import { readConsent, subscribeConsent } from '@/lib/consent';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

/**
 * Browser-side PostHog: pageviews, autocapture, session replay, web vitals —
 * everything the JS SDK ships by default. No-op until NEXT_PUBLIC_POSTHOG_KEY
 * is set (same fail-open contract as the server-side seam in lib/analytics).
 * Identified with the Clerk user id + org group so browser sessions line up
 * with the server-side business events — ids only, never PII.
 *
 * GDPR/ePrivacy: analytics + replay are OPT-IN. Nothing initializes until the
 * cookie banner records "granted" (lib/consent.ts); revoking consent later
 * opts the loaded SDK out of capturing.
 */
export function PostHogInit({
  initialConsent,
}: {
  /** Server-read consent cookie: keeps the server snapshot identical to the
   * first client render (see CookieBanner — a mismatch here crashes iOS). */
  initialConsent: 'granted' | 'denied' | null;
}) {
  const { userId, orgId } = useAuth();
  // useSyncExternalStore, NOT a mount-effect setState: a post-hydration setState
  // cascade in the root layout crashes the Next router on WebKit/iOS
  // ("Rendered more hooks…", facebook/react#33580).
  const consent = useSyncExternalStore(
    subscribeConsent,
    readConsent,
    () => initialConsent,
  );

  useEffect(() => {
    if (!KEY) return;
    if (consent === 'granted') {
      if (!posthog.__loaded) {
        // First-party reverse proxy (see rewrites in next.config.ts) so
        // adblockers don't drop events; ui_host keeps toolbar/replay links on
        // the real region.
        posthog.init(KEY, {
          api_host: '/ingest',
          ui_host: 'https://eu.posthog.com',
          defaults: '2026-05-30',
        });
      } else if (posthog.has_opted_out_capturing()) {
        posthog.opt_in_capturing();
      }
    } else if (consent === 'denied' && posthog.__loaded) {
      // Consent revoked mid-session: stop capturing (incl. replay) now.
      posthog.opt_out_capturing();
    }
  }, [consent]);

  useEffect(() => {
    if (!KEY || !posthog.__loaded) return;
    if (userId) {
      posthog.identify(userId);
      if (orgId) posthog.group('organization', orgId);
    } else if (posthog._isIdentified()) {
      // Sign-out: drop the identity so the next visitor on this browser
      // doesn't inherit the previous user's profile.
      posthog.reset();
    }
  }, [userId, orgId, consent]);

  return null;
}
