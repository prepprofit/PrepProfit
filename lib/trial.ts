import { cache } from 'react';
import {
  type EffectiveEntitlementState,
  trialReminderDaysLeft,
  getEffectiveEntitlementState,
} from '@/lib/entitlements';

/**
 * Serializable trial read-model for the reverse-trial UI surfaces (dashboard card, top
 * banner). Derived from the effective entitlement state; present ONLY while the reverse
 * trial is the active source. Every field is a plain value so it can cross the
 * server→client boundary into `AppShell` without shipping a `Date`.
 */
export type TrialView = {
  source: 'trial';
  /** Whole UTC-calendar days left, clamped to `0` for display (never negative). */
  daysLeft: number;
  /** True on the last trial day — surfaces an "Ends today" label instead of "0 left". */
  endsToday: boolean;
  /** The deadline as an ISO string (not a `Date`), for any client-side formatting. */
  trialEndsAtIso: string;
};

/**
 * Whole UTC-calendar days from `now` until `end`, clamped to `0` for DISPLAY. Reuses the
 * UTC-midnight math of {@link trialReminderDaysLeft}, which can go negative once the
 * deadline passes; the UI never shows a negative count.
 */
export function trialDaysLeft(end: Date | null, now: Date): number {
  if (end == null) return 0;
  return Math.max(0, trialReminderDaysLeft(end, now));
}

/**
 * Pure projection of the effective entitlement state into a {@link TrialView}. Returns
 * `null` for every non-trial source (`paid`, `free`, `comped`) and when the deadline is
 * unknown, so the trial surfaces render only during an active reverse trial.
 */
export function deriveTrialView(
  state: EffectiveEntitlementState,
  now: Date,
): TrialView | null {
  if (state.source !== 'trial' || state.trialEndsAt == null) return null;
  const daysLeft = trialDaysLeft(state.trialEndsAt, now);
  return {
    source: 'trial',
    daysLeft,
    endsToday: daysLeft === 0,
    trialEndsAtIso: state.trialEndsAt.toISOString(),
  };
}

/**
 * Request-cached trial view for the active org. Cached so the app layout and the
 * dashboard page can both call it within one request without a second entitlement read.
 * No DB I/O — `getEffectiveEntitlementState()` reads the session claim.
 */
export const getTrialView = cache(async (): Promise<TrialView | null> => {
  return deriveTrialView(await getEffectiveEntitlementState(), new Date());
});
