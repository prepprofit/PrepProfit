/**
 * Soft-delete / trash policy, shared by the data layer, the auto-purge cron, and
 * the /trash UI so the retention window is defined in exactly one place.
 */

/** How long a soft-deleted row stays in the trash before it is auto-purged. */
export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The purge cutoff: rows whose `deleted_at` is at or before this instant have
 * outlived the retention window and are eligible for permanent deletion.
 */
export function purgeCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
}

/**
 * Whole days remaining before a trashed row is auto-purged. Clamped to ≥ 0, so a
 * row already past the window reads as 0 ("expires today") rather than negative.
 */
export function daysLeft(deletedAt: Date, now: Date = new Date()): number {
  const elapsedDays = Math.floor((now.getTime() - deletedAt.getTime()) / DAY_MS);
  return Math.max(0, TRASH_RETENTION_DAYS - elapsedDays);
}
