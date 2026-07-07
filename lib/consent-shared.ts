/**
 * Consent constants/parsing shared by server and client code. No 'use client':
 * the root layout (a Server Component) reads the consent cookie to seed the
 * client components' server snapshot, so server HTML and first client render
 * agree and hydration never mismatches in the root layout (the WebKit/iOS
 * "Rendered more hooks…" crash trigger).
 */

export const CONSENT_COOKIE = 'pp_cookie_consent';
export const CONSENT_MAX_AGE_DAYS = 365;

export type ConsentValue = 'granted' | 'denied';

export function parseConsent(value: string | undefined): ConsentValue | null {
  return value === 'granted' || value === 'denied' ? value : null;
}
