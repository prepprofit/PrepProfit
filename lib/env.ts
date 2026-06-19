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
 */
const emailEnvSchema = z.object({
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY must not be empty'),
  RESEND_FROM_EMAIL: z
    .string()
    .email('RESEND_FROM_EMAIL must be a valid email address'),
  RESEND_REPLY_TO: z
    .string()
    .email('RESEND_REPLY_TO must be a valid email address')
    .optional(),
});

/** The Resend config required to actually send mail (a narrowed, non-optional view). */
export type EmailEnv = {
  apiKey: string;
  from: string;
  replyTo?: string;
};

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
    from: parsed.data.RESEND_FROM_EMAIL,
    replyTo: parsed.data.RESEND_REPLY_TO,
  };
}
