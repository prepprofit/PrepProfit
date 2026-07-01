import {
  inspectImage,
  MAX_IMAGE_BYTES,
  MIN_IMAGE_DIM,
  MAX_IMAGE_DIM,
  type AllowedImageMime,
} from '@/lib/ai/image';

/**
 * Document upload validation for the Supplier Invoice Reader (Sprint 2, AI margin
 * roadmap). PURE and SDK-free so it unit-tests from byte fixtures.
 *
 * An invoice is an image OR a PDF, so this extends the photo path's image sniffing
 * (`lib/ai/image.ts`) with PDF detection. Security posture is identical: the client's
 * `Content-Type` is NOT trusted — we sniff the magic bytes, derive the REAL format,
 * and reject anything that is not a JPEG/PNG/WebP/PDF. Size is hard-capped (anti-DoS);
 * image dimensions, when parseable, are bounded. A script renamed `.pdf` (or sent with
 * an `application/pdf` mime) is rejected because its bytes are neither an image nor a
 * `%PDF-` header.
 */

export const PDF_MIME = 'application/pdf';
export type AllowedDocumentMime = AllowedImageMime | typeof PDF_MIME;

/** Reuse the image cap: 8 MB is generous for a phone photo or a single-page PDF. */
export const MAX_DOCUMENT_BYTES = MAX_IMAGE_BYTES;

export type DocumentRejectReason =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'MIME_MISMATCH'
  | 'BAD_DIMENSIONS';

export type DocumentValidation =
  | { ok: true; mime: AllowedDocumentMime }
  | { ok: false; reason: DocumentRejectReason };

/** True when the bytes start with the `%PDF-` signature. */
function isPdf(bytes: Buffer): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d //   -
  );
}

/**
 * Validate one uploaded invoice document. `claimedMime` is the browser-declared type —
 * it must MATCH the sniffed bytes, never override them. On success returns the TRUSTED
 * mime (derived from the bytes) to send to the provider.
 */
export function validateDocumentUpload(
  bytes: Buffer,
  claimedMime: string,
): DocumentValidation {
  if (bytes.length === 0) return { ok: false, reason: 'EMPTY' };
  if (bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'TOO_LARGE' };

  const claimed = claimedMime ? claimedMime.toLowerCase().split(';')[0]?.trim() : '';

  if (isPdf(bytes)) {
    if (claimed && claimed !== PDF_MIME) return { ok: false, reason: 'MIME_MISMATCH' };
    return { ok: true, mime: PDF_MIME };
  }

  const sniffed = inspectImage(bytes);
  if (!sniffed) return { ok: false, reason: 'UNSUPPORTED_TYPE' };

  const trustedMime: AllowedImageMime =
    sniffed.format === 'jpeg'
      ? 'image/jpeg'
      : sniffed.format === 'png'
        ? 'image/png'
        : 'image/webp';
  if (claimed && claimed !== trustedMime) {
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

  return { ok: true, mime: trustedMime };
}
