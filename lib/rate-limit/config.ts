/**
 * Rate-limit buckets (Sprint 3.1). One entry per abusable surface; the limiter
 * (lib/rate-limit/index.ts) reads `{ limit, windowMs }` for the bucket. Keep the
 * windows generous — this is abuse prevention, not quota billing (plan limits land
 * in Sprint 4). Authenticated buckets are keyed per org+user; `cronPurge` is keyed
 * by a hash of the cron auth header.
 */
export type RateLimitConfig = {
  /** Max allowed hits within the window. */
  limit: number;
  /** Window length in milliseconds (fixed window). */
  windowMs: number;
};

const MINUTE = 60_000;

export const RATE_LIMITS = {
  // Global search action — interactive, so allow a brisk cadence per user.
  search: { limit: 30, windowMs: MINUTE },
  // Transactions CSV export route — heavier, manager-only.
  transactionsExport: { limit: 10, windowMs: MINUTE },
  // Daily cron purge — generous ceiling; only abusive retries should ever trip it.
  cronPurge: { limit: 5, windowMs: MINUTE },
  // Document generation (Sprint 3.5A invoice PDF/print; 3.5B report PDF/XLSX
  // downloads) — manager-only, heavier than a read, but interactive enough to
  // allow a brisk cadence per user.
  documents: { limit: 20, windowMs: MINUTE },
  // Outbound document email (Sprint 3.5C). Tighter than `documents`: a send has
  // real cost and spam/reputation risk a local download does not, so it gets its
  // own, smaller budget per org+user.
  documentEmail: { limit: 10, windowMs: MINUTE },
  // Staged import (Sprint 4.5): template download, dry-run preview (parses a file),
  // and confirm. Per org+user; generous enough for normal use, tight enough that
  // scripted file-upload abuse trips it.
  import: { limit: 20, windowMs: MINUTE },
  // Reserved for later sprints (helper already exists; nothing wired yet):
  //   aiExtraction:  Sprint 4.7 photo recipe extraction
} as const satisfies Record<string, RateLimitConfig>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;
