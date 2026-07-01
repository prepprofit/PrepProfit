/**
 * Pre-parse request-size guard (pre-launch audit F3, 2026-07-02). The upload/AI
 * routes validate body bytes AFTER `req.formData()` / `req.json()` has already
 * buffered them, so an oversized body used to consume memory and function time
 * before being rejected. Checking the declared `Content-Length` first lets the
 * route answer 413 without touching the body.
 *
 * A missing/invalid header is deliberately NOT rejected: legitimate proxies may
 * use chunked encoding, the deployment platform (Vercel) enforces its own hard
 * body cap (~4.5 MB) before the function runs, and the existing post-parse byte
 * validators remain the authoritative limit. This guard is a cheap fast-fail for
 * honestly-declared oversized bodies, not the security boundary.
 */

/** Generous allowance for multipart boundaries/part headers around one file field. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** True when the request DECLARES a body larger than `maxBytes` — reject with 413. */
export function declaredBodyExceeds(req: Request, maxBytes: number): boolean {
  const raw = req.headers.get('content-length');
  if (raw === null) return false;
  const declared = Number(raw);
  if (!Number.isFinite(declared)) return false; // malformed → let the parser reject it
  return declared > maxBytes;
}
