import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF/DoS-safe loader for the org's logo URL, embedded into the server-rendered
 * invoice PDF (Sprint 3.5A). A manager-supplied `https://` URL is otherwise an
 * SSRF vector: it could resolve to a private/link-local/loopback address (cloud
 * metadata, localhost, internal services) or stream an enormous/slow body that
 * stalls the PDF route. We therefore, before letting `@react-pdf/renderer` touch
 * the URL:
 *   - require https
 *   - resolve the hostname and refuse any private/loopback/link-local/reserved IP
 *   - disallow redirects (`redirect: 'error'`) so a public URL can't bounce to one
 *   - enforce a request timeout, a content-type allowlist, and a hard byte cap
 *     (streamed, so a server ignoring Content-Length can't blow up memory)
 * On ANY failure we return null (the document renders with no logo) — a bad logo
 * must never break or block the download.
 *
 * Residual risk: TOCTOU/DNS-rebinding between our `lookup()` and fetch's own
 * resolution. Disallowing redirects + the byte/time caps keep the blast radius
 * small; pinning to the resolved IP would break TLS SNI/cert validation, so it is
 * deliberately not done here.
 */

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);
const MAX_BYTES = 2_000_000; // 2 MB
const TIMEOUT_MS = 3000;

/** Block loopback / private / link-local / CGNAT / reserved / multicast IPs. */
export function isBlockedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not a parseable IP → refuse

  if (family === 4) return isBlockedIpv4(address);
  return isBlockedIpv6(address);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 special-use
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:127.0.0.1) — validate the embedded IPv4.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 unique-local
  // fe80::/10 link-local (fe80..febf)
  if (/^fe[89ab]/.test(ip)) return true;
  if (ip.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

/**
 * Fetch the logo and return a base64 `data:` URI safe to embed in the PDF, or null
 * if the URL is absent/invalid/unsafe/unreachable. The returned data URI is local
 * bytes, so the renderer never performs its own network request.
 */
export async function loadSafeLogo(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  // Resolve the hostname and refuse if ANY resolved address is non-public.
  try {
    const addresses = await lookup(parsed.hostname, { all: true });
    if (addresses.length === 0) return null;
    if (addresses.some((a) => isBlockedIp(a.address))) return null;
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(parsed, {
      redirect: 'error', // no redirects → can't bounce a public URL to a private IP
      signal: controller.signal,
      headers: { accept: 'image/*' },
    });
    if (!res.ok) return null;

    const contentType = (res.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) return null;

    const declaredLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) return null;

    const buffer = await readCapped(res, MAX_BYTES);
    if (!buffer || buffer.length === 0) return null;

    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the response body, aborting if it exceeds `maxBytes`. Returns null on overflow. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No stream — fall back to a single buffered read with a post-cap.
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}
