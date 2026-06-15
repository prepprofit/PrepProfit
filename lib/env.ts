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
