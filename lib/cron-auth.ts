import { timingSafeEqual } from 'node:crypto';

/**
 * Whether a request carries the expected cron secret in its Authorization
 * header (`Bearer <CRON_SECRET>`). The scheduler sends it explicitly — each Coolify
 * Scheduled Task reads `CRON_SECRET` from the container env and sets the header
 * itself (see `docs/production-operations.md`). Constant-time comparison; returns
 * false if no secret is configured or the header is missing/mismatched — secure by
 * default.
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
