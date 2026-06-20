/**
 * Image upload validation for AI photo extraction (Sprint 4.7, D3). PURE and
 * SDK-free so it unit-tests from byte fixtures.
 *
 * Security posture: the client's `Content-Type` is NOT trusted. We sniff the magic
 * bytes, derive the REAL format, and reject anything that is not a JPEG/PNG/WebP —
 * so a PDF or script renamed `.png` (or sent with an image mime) is rejected before
 * the bytes ever reach the provider. Size is hard-capped (anti-DoS) and dimensions,
 * when parseable, are bounded (degenerate 1×1 or enormous canvases are refused).
 */

export const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

export type ImageFormat = 'jpeg' | 'png' | 'webp';
const MIME_BY_FORMAT: Record<ImageFormat, AllowedImageMime> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Hard caps. 8 MB is generous for a phone photo; dims guard degenerate inputs. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MIN_IMAGE_DIM = 16;
export const MAX_IMAGE_DIM = 12_000;

type Dimensions = { width: number; height: number };

/** PNG: 8-byte signature, then an IHDR chunk with width/height as BE uint32. */
function pngDimensions(b: Buffer): Dimensions | null {
  if (b.length < 24) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** JPEG: scan segment markers for an SOF frame header carrying the dimensions. */
function jpegDimensions(b: Buffer): Dimensions | null {
  let i = 2; // past the SOI (FF D8)
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) {
      i++; // resync over fill/padding bytes
      continue;
    }
    const marker = b[i + 1];
    if (marker === undefined) return null;
    // Standalone markers (no length): SOI/EOI, RSTn, TEM.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15 carry frame dimensions; exclude DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** WebP (RIFF/WEBP): VP8 (lossy) / VP8L (lossless) / VP8X (extended) dimensions. */
function webpDimensions(b: Buffer): Dimensions | null {
  const fourcc = b.toString('ascii', 12, 16);
  if (fourcc === 'VP8 ' && b.length >= 30) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X' && b.length >= 30) {
    // 24-bit little-endian canvas dimensions minus one.
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function isWebp(b: Buffer): boolean {
  return (
    b.length >= 16 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  );
}

/**
 * Sniff the real image format from magic bytes (NOT the declared mime). Returns the
 * format + best-effort dimensions, or `null` when the bytes are not a supported image.
 */
export function inspectImage(b: Buffer): {
  format: ImageFormat;
  width: number | null;
  height: number | null;
} | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const d = jpegDimensions(b);
    return { format: 'jpeg', width: d?.width ?? null, height: d?.height ?? null };
  }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const d = pngDimensions(b);
    return { format: 'png', width: d?.width ?? null, height: d?.height ?? null };
  }
  if (isWebp(b)) {
    const d = webpDimensions(b);
    return { format: 'webp', width: d?.width ?? null, height: d?.height ?? null };
  }
  return null;
}

export type ImageRejectReason =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'MIME_MISMATCH'
  | 'BAD_DIMENSIONS';

export type ImageValidation =
  | { ok: true; mime: AllowedImageMime; width: number | null; height: number | null }
  | { ok: false; reason: ImageRejectReason };

/**
 * Validate one uploaded image. `claimedMime` is the browser-declared type — it must
 * MATCH the sniffed bytes, never override them. On success returns the TRUSTED mime
 * (derived from the bytes) to send to the provider.
 */
export function validateImageUpload(bytes: Buffer, claimedMime: string): ImageValidation {
  if (bytes.length === 0) return { ok: false, reason: 'EMPTY' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'TOO_LARGE' };

  const sniffed = inspectImage(bytes);
  if (!sniffed) return { ok: false, reason: 'UNSUPPORTED_TYPE' };

  const trustedMime = MIME_BY_FORMAT[sniffed.format];
  if (claimedMime && claimedMime.toLowerCase().split(';')[0]?.trim() !== trustedMime) {
    return { ok: false, reason: 'MIME_MISMATCH' };
  }

  if (sniffed.width !== null && sniffed.height !== null) {
    const { width, height } = sniffed;
    if (
      width < MIN_IMAGE_DIM ||
      height < MIN_IMAGE_DIM ||
      width > MAX_IMAGE_DIM ||
      height > MAX_IMAGE_DIM
    ) {
      return { ok: false, reason: 'BAD_DIMENSIONS' };
    }
  }

  return { ok: true, mime: trustedMime, width: sniffed.width, height: sniffed.height };
}
