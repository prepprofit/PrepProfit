import { timingSafeEqual } from 'node:crypto';

/**
 * Whether a request carries the expected cron secret in its Authorization
 * header (`Bearer <CRON_SECRET>`). Vercel Cron sends this automatically when the
 * `CRON_SECRET` env var is set. Constant-time comparison; returns false if no
 * secret is configured or the header is missing/mismatched — secure by default.
 */
export function isCronAuthorized(
  authHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || !authHeader) return false;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(`Bearer ${secret}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
