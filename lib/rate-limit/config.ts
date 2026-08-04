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
  // AI photo recipe extraction (Sprint 4.7). TIGHT: each call uploads an image and
  // hits a paid vision provider, so it gets a much smaller per-minute budget than a
  // local import. This is burst/abuse control; the monthly per-plan cap (counted in
  // ai_extraction_attempts) is the separate quota control.
  aiExtraction: { limit: 5, windowMs: MINUTE },
  // AI supplier-invoice extraction (Sprint 2, AI margin roadmap). TIGHT like
  // `aiExtraction`: each call uploads a document and hits a paid vision provider, so
  // it gets a small per-minute budget. Burst/abuse control; the monthly per-plan cap
  // (counted in ai_operation_attempts) is the separate quota control.
  supplierInvoiceExtract: { limit: 5, windowMs: MINUTE },
  // AI profit-leak explanation (Sprint 4, AI margin roadmap). Interactive text call to
  // a paid provider — lighter than a vision upload, so a slightly higher per-minute
  // budget than `aiExtraction`, but still burst/abuse control. The monthly per-plan cap
  // (counted in ai_operation_attempts, feature profit_leak_explanation) is the separate
  // quota control. Per org+user.
  aiExplain: { limit: 10, windowMs: MINUTE },
  // AI daily-close summary (Sprint 6, AI margin roadmap). Interactive text call to a paid
  // provider, like `aiExplain` — burst/abuse control only; the monthly per-plan cap
  // (counted in ai_operation_attempts, feature daily_close_summary) is the separate quota
  // control. Per org+user.
  aiDailyClose: { limit: 10, windowMs: MINUTE },
  // AI prep/reorder plan summary (Sprint 7, AI margin roadmap). Interactive text call to a
  // paid provider, like `aiExplain`/`aiDailyClose` — burst/abuse control only; the monthly
  // per-plan cap (counted in ai_operation_attempts, feature prep_reorder_plan_summary) is the
  // separate quota control. Per org+user.
  aiPrepPlan: { limit: 10, windowMs: MINUTE },
  // AI weekly CFO report (Sprint 8, AI margin roadmap). Interactive text call to a paid
  // provider, like `aiDailyClose`/`aiPrepPlan` — burst/abuse control only; the monthly
  // per-plan cap (counted in ai_operation_attempts, feature kitchen_cfo_report) is the
  // separate quota control. Per org+user.
  aiCfoReport: { limit: 10, windowMs: MINUTE },
  // Email-outbox cron worker (Sprint 8a). Like `cronPurge`, keyed by a hash of the
  // cron auth header (the worker is org-less at entry). Generous ceiling — only
  // abusive retries should trip it; the legitimate scheduled task fires once a day.
  outboxWorker: { limit: 5, windowMs: MINUTE },
  // Weekly AI-spend report cron. Keyed by a hash of the cron auth header (org-less at
  // entry). Generous ceiling — only abusive retries should trip it; the legitimate
  // scheduled task fires once a week.
  aiCostReport: { limit: 5, windowMs: MINUTE },
  // Weekly CFO report enqueue cron (React Email migration). Org-less at entry, keyed by
  // a hash of the cron auth header like the other cron buckets. Generous ceiling — only
  // abusive retries should trip it; the legitimate scheduled task fires once a week.
  cfoReportEnqueue: { limit: 5, windowMs: MINUTE },
  // Reverse-trial ending reminder cron (pricing 4-tier plan, Slice 6). Org-less at
  // entry, keyed by a hash of the cron auth header like the other cron buckets.
  // Generous ceiling — only abusive retries should trip it; the legitimate scheduled
  // task fires once a day.
  trialReminder: { limit: 5, windowMs: MINUTE },
  // Inventory depth mutations (Sprint 12c) — area CRUD, transfers, count commits. Per
  // org+user; interactive operational writes, so a brisk cadence is fine.
  inventory: { limit: 30, windowMs: MINUTE },
  // Recipe media upload-url + confirm routes (Recipes 2.0 Fase 3). Per org+user;
  // each hit issues a signed URL or reads bucket bytes, so it is heavier than a
  // plain read but interactive — a step-by-step photo session needs a brisk cadence.
  recipeMedia: { limit: 20, windowMs: MINUTE },
  // Recipe-media cleanup cron (Fase 3). Keyed by a hash of the cron auth header
  // like the other cron buckets. Generous ceiling — only abusive retries trip it.
  mediaSweep: { limit: 5, windowMs: MINUTE },
  // USDA FoodData Central search/detail (Recipes 2.0 Fase 6). Per org+user;
  // each hit calls the external USDA API (free but externally rate-limited per
  // key), so keep an interactive-but-modest budget to protect the shared key.
  usdaSearch: { limit: 20, windowMs: MINUTE },
  // Open Food Facts barcode lookup (OFF integration plan §13) — PER ORG+USER.
  // Interactive-but-modest, separate from usdaSearch so it can be tuned alone.
  openFoodFactsRead: { limit: 20, windowMs: MINUTE },
  // Open Food Facts GLOBAL egress ceiling — keyed by a single constant scope so
  // it caps the whole app's outbound OFF requests from the shared production IP.
  // Start at 10/min, under OFF's documented 15 product reads/min/IP (plan §13).
  openFoodFactsGlobal: { limit: 10, windowMs: MINUTE },
  // Seed ingredient catalogue search (in-memory, no external API, cheap) —
  // generous interactive budget; the limiter is here only to keep the shared
  // "rate limit before org work" pattern and stop scripted scraping.
  catalogSearch: { limit: 60, windowMs: MINUTE },
  // GDPR account data export (Sprint 5e). TIGHT: reads every business table and
  // serialises the whole org, so it is the heaviest read in the app — a small
  // per-org+user budget is plenty for a legitimate portability request.
  accountExport: { limit: 3, windowMs: MINUTE },
} as const satisfies Record<string, RateLimitConfig>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;
