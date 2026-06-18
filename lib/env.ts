import { z } from 'zod';

/**
 * Server environment validation. Parsed LAZILY (on first access, at runtime) —
 * never at import time — so `next build` / CI stay green without runtime secrets
 * and the Neon client (lib/db/index.ts) can stay lazy. A missing/invalid var
 * fails fast with one aggregated, readable error instead of a vague crash deep
 * in a request.
 *
 * Only vars we read ourselves live here; Clerk's `NEXT_PUBLIC_CLERK_*` /
 * `CLERK_SECRET_KEY` are validated by the Clerk SDK.
 */
const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection URL'),
  // Authenticates the Vercel Cron → /api/cron/purge-trash call (lib/cron-auth.ts).
  CRON_SECRET: z
    .string()
    .min(16, 'CRON_SECRET must be at least 16 characters')
    .optional(),
  // Resend document email (Sprint 3.5C). OPTIONAL here so the many other
  // `serverEnv()` callers (e.g. `getDb()`) don't suddenly require email config;
  // `emailEnv()` below asserts the two required vars only when email is actually
  // sent. The API key is a secret — it is NEVER logged.
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY must not be empty').optional(),
  RESEND_FROM_EMAIL: z
    .string()
    .email('RESEND_FROM_EMAIL must be a valid email address')
    .optional(),
  RESEND_REPLY_TO: z
    .string()
    .email('RESEND_REPLY_TO must be a valid email address')
    .optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/**
 * Validated server env, cached after the first call. Throws an aggregated error
 * listing every missing/invalid var. Call inside handlers / `getDb()` — not at
 * module top level — to keep validation at runtime.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid server environment:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** The Resend config required to actually send mail (a narrowed, non-optional view). */
export type EmailEnv = {
  apiKey: string;
  from: string;
  replyTo?: string;
};

/**
 * Asserts the email-sending vars are configured and returns them narrowed. Throws
 * a readable (key-free) error if `RESEND_API_KEY` / `RESEND_FROM_EMAIL` are missing
 * — the email action maps that to a stable `EMAIL_FAILED` code and logs it via
 * `logError` (which never receives the key itself). Call only on the send path.
 */
export function emailEnv(): EmailEnv {
  const env = serverEnv();
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error(
      'Email is not configured: set RESEND_API_KEY and RESEND_FROM_EMAIL.',
    );
  }
  return {
    apiKey: env.RESEND_API_KEY,
    from: env.RESEND_FROM_EMAIL,
    replyTo: env.RESEND_REPLY_TO,
  };
}
