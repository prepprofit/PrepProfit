'use client';

/**
 * Cookie-consent state for the optional analytics stack (PostHog pageviews,
 * autocapture and session replay). GDPR/ePrivacy: analytics is opt-in, so
 * nothing non-essential runs until the visitor grants consent via the banner.
 *
 * Strictly-necessary cookies (Clerk auth, theme, Crisp chat session) are NOT
 * gated here — they are documented in the privacy policy instead.
 *
 * Stored as a first-party cookie so the choice survives across visits and is
 * readable before any vendor script loads. A custom DOM event fans the change
 * out to listeners (the PostHog initializer) without a state library.
 */

export const CONSENT_COOKIE = 'pp_cookie_consent';
export const CONSENT_MAX_AGE_DAYS = 365;
export const CONSENT_CHANGE_EVENT = 'pp-consent-change';
export const CONSENT_OPEN_EVENT = 'pp-consent-open';

export type ConsentValue = 'granted' | 'denied';

export function readConsent(): ConsentValue | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${CONSENT_COOKIE}=`));
  const value = match?.split('=')[1];
  return value === 'granted' || value === 'denied' ? value : null;
}

export function writeConsent(value: ConsentValue): void {
  const maxAge = CONSENT_MAX_AGE_DAYS * 24 * 60 * 60;
  document.cookie = `${CONSENT_COOKIE}=${value}; path=/; max-age=${maxAge}; SameSite=Lax${
    location.protocol === 'https:' ? '; Secure' : ''
  }`;
  window.dispatchEvent(
    new CustomEvent<ConsentValue>(CONSENT_CHANGE_EVENT, { detail: value }),
  );
}

/**
 * `useSyncExternalStore` subscription for consent changes. Components read
 * consent via `useSyncExternalStore(subscribeConsent, readConsent, () => null)`
 * instead of a mount-effect `setState` — a post-hydration setState cascade in
 * the root layout triggers a React 19 "Rendered more hooks than during the
 * previous render" crash in the Next router on WebKit (facebook/react#33580).
 */
export function subscribeConsent(onChange: () => void): () => void {
  window.addEventListener(CONSENT_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CONSENT_CHANGE_EVENT, onChange);
}

/** Reopen the banner (footer "Cookie settings" / settings page). */
export function openConsentBanner(): void {
  window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));
}
