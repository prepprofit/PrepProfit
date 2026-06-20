import { z } from 'zod';

/**
 * Server environment validation. Parsed LAZILY (on first access, at runtime) —
 * never at import time — so `next build` / CI stay green without runtime secrets
 * and the Neon client (lib/db/index.ts) can stay lazy. A missing/invalid var
 * fails fast with one aggregated, readable error instead of a vague crash deep
 * in a request.
 *
 * SCOPE: this schema holds ONLY the vars that nearly every request depends on —
 * `getDb()` and the cron route call `serverEnv()`, so a bad var here takes down
 * the whole app. Feature-specific config (e.g. Resend email) MUST NOT live here:
 * it gets its own narrow schema validated on its own code path (see `emailEnv()`),
 * so a misconfigured optional feature can never crash unrelated pages. (This is
 * not hypothetical — an invalid `RESEND_FROM_EMAIL` once made `serverEnv()` throw
 * for every `getDb()` caller and 500'd every data page.)
 *
 * Clerk's `NEXT_PUBLIC_CLERK_*` / `CLERK_SECRET_KEY` are validated by the Clerk SDK.
 */
const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection URL'),
  // Authenticates the Vercel Cron → /api/cron/purge-trash call (lib/cron-auth.ts).
  CRON_SECRET: z
    .string()
    .min(16, 'CRON_SECRET must be at least 16 characters')
    .optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/** Format Zod issues as one readable, indented bullet list. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
}

/**
 * Validated server env, cached after the first call. Throws an aggregated error
 * listing every missing/invalid var. Call inside handlers / `getDb()` — not at
 * module top level — to keep validation at runtime.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment:\n${formatIssues(parsed.error)}`);
  }

  cached = parsed.data;
  return cached;
}

/**
 * Resend document email config (Sprint 3.5C). Validated on its OWN schema, read
 * only by {@link emailEnv} on the send path — deliberately NOT part of
 * `serverEnvSchema`, so a missing or malformed value fails only when an email is
 * actually sent (mapped to the stable `EMAIL_FAILED` code) and never bricks the
 * DB-backed pages. The API key is a secret — it is NEVER logged.
 *
 * `RESEND_FROM_EMAIL` is the bare address only — the human display name lives in
 * `RESEND_FROM_NAME` (default below) and is composed into the `From` header by
 * {@link emailEnv}. Keeping them separate means the address still passes strict
 * `.email()` validation; do NOT put `Name <addr>` in `RESEND_FROM_EMAIL`.
 */
const emailEnvSchema = z.object({
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY must not be empty'),
  RESEND_FROM_EMAIL: z
    .string()
    .email('RESEND_FROM_EMAIL must be a valid email address'),
  RESEND_FROM_NAME: z.string().min(1).optional(),
  RESEND_REPLY_TO: z
    .string()
    .email('RESEND_REPLY_TO must be a valid email address')
    .optional(),
});

/** Sender display name shown to recipients when `RESEND_FROM_NAME` is unset. */
const DEFAULT_FROM_NAME = 'PrepProfit';

/**
 * Build an RFC 5322 `From` header value: `Name <addr>`. The display name is
 * quoted only when it contains characters outside a plain atom (e.g. a comma in
 * "PrepProfit, Inc."), so simple brand names stay unquoted.
 */
function formatFrom(name: string, email: string): string {
  const display = /^[A-Za-z0-9 ]+$/.test(name)
    ? name
    : `"${name.replace(/"/g, '\\"')}"`;
  return `${display} <${email}>`;
}

/**
 * True when Resend is configured enough to send mail, WITHOUT throwing. Lifecycle
 * notifications (Sprint 5d: welcome, low-stock digest) are best-effort and
 * non-critical, so their call sites check this first and skip QUIETLY when email is
 * not set up — never logging a config error for an optional feature. (The
 * user-triggered document email path, by contrast, calls {@link emailEnv} and
 * surfaces `EMAIL_FAILED`.)
 */
export function isEmailConfigured(): boolean {
  return emailEnvSchema.safeParse(process.env).success;
}

/** The Resend config required to actually send mail (a narrowed, non-optional view). */
export type EmailEnv = {
  apiKey: string;
  /** Ready-to-send `From` header, e.g. `PrepProfit <info@prepprofit.com>`. */
  from: string;
  replyTo?: string;
};

/**
 * Product analytics config (Sprint 5c). PostHog server-side capture of a small
 * allowlist of business events (no PII, no money). Validated on its OWN narrow
 * schema, read only by {@link analyticsEnv} on the capture path — NOT part of
 * `serverEnvSchema`, so a missing key just disables analytics (fail-open) and never
 * affects a request. The key is a project write key (not a secret like an API
 * secret), but is still only read from env, never logged.
 */
const analyticsEnvSchema = z.object({
  POSTHOG_KEY: z.string().min(1),
  POSTHOG_HOST: z
    .string()
    .url()
    .optional()
    .default('https://us.i.posthog.com'),
});

export type AnalyticsEnv = { key: string; host: string };

/** True when PostHog is configured, WITHOUT throwing (fail-open analytics gate). */
export function isAnalyticsConfigured(): boolean {
  return analyticsEnvSchema.safeParse(process.env).success;
}

/**
 * Returns the analytics config, or `null` when unconfigured (so the caller no-ops
 * instead of throwing — analytics is never load-bearing). Never logs the key.
 */
export function analyticsEnv(): AnalyticsEnv | null {
  const parsed = analyticsEnvSchema.safeParse(process.env);
  if (!parsed.success) return null;
  return { key: parsed.data.POSTHOG_KEY, host: parsed.data.POSTHOG_HOST };
}

/**
 * AI photo recipe extraction config (Sprint 4.7). Validated on its OWN narrow
 * schema, read only by {@link aiEnv} on the extraction path — deliberately NOT
 * part of `serverEnvSchema`, so a missing or malformed key fails only when an
 * extraction is actually attempted (mapped to the stable `AI_EXTRACTION_FAILED`
 * code) and never bricks the DB-backed pages. The API key is a secret — it is
 * NEVER logged (the thrown message names only the var, never its value).
 */
const aiEnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY must not be empty'),
});

/** The Gemini config required to call the extraction provider. */
export type AiEnv = {
  apiKey: string;
};

/**
 * Asserts the AI-extraction key is configured and returns it narrowed. Throws a
 * readable (key-free) error if `GEMINI_API_KEY` is missing or empty — the extract
 * action maps that to a stable `AI_EXTRACTION_FAILED` code and logs it via
 * `logError` (which never receives the key itself). Call only on the extraction
 * path: validation is scoped here so missing AI config never crashes the rest of
 * the app. The thrown message lists only the var NAME, never its (secret) value.
 */
export function aiEnv(): AiEnv {
  const parsed = aiEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`AI extraction is not configured:\n${formatIssues(parsed.error)}`);
  }
  return { apiKey: parsed.data.GEMINI_API_KEY };
}

/**
 * Asserts the email-sending vars are configured and returns them narrowed. Throws
 * a readable (key-free) error if `RESEND_API_KEY` / `RESEND_FROM_EMAIL` are missing
 * or malformed — the email action maps that to a stable `EMAIL_FAILED` code and
 * logs it via `logError` (which never receives the key itself). Call only on the
 * send path: validation is scoped here so bad email config never crashes the rest
 * of the app. The thrown message lists only var NAMES, never their (secret) values.
 */
export function emailEnv(): EmailEnv {
  const parsed = emailEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Email is not configured:\n${formatIssues(parsed.error)}`);
  }
  return {
    apiKey: parsed.data.RESEND_API_KEY,
    from: formatFrom(
      parsed.data.RESEND_FROM_NAME ?? DEFAULT_FROM_NAME,
      parsed.data.RESEND_FROM_EMAIL,
    ),
    replyTo: parsed.data.RESEND_REPLY_TO,
  };
}
