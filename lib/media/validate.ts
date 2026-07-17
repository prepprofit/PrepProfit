/**
 * Pure magic-byte / dimension validation for recipe media (plan §6.4). The
 * confirm route runs this over the FIRST bytes of the uploaded object — the
 * client's declared MIME type is untrusted, so the real container bytes
 * decide. Images must expose readable dimensions within the sniff window;
 * videos are validated by container signature + size only (duration parsing
 * needs the moov atom, which may sit at the END of an MP4 — deferred, the
 * column stays nullable).
 */

export const RECIPE_MEDIA_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const RECIPE_MEDIA_VIDEO_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
export const RECIPE_MEDIA_MAX_DIMENSION_PX = 10_000;
/** How many leading bytes the confirm route should fetch for validation. */
export const RECIPE_MEDIA_SNIFF_BYTES = 512 * 1024;

export const RECIPE_MEDIA_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const RECIPE_MEDIA_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
] as const;

export type RecipeMediaImageMime = (typeof RECIPE_MEDIA_IMAGE_MIME_TYPES)[number];
export type RecipeMediaVideoMime = (typeof RECIPE_MEDIA_VIDEO_MIME_TYPES)[number];

export type MediaValidationResult =
  | {
      ok: true;
      kind: 'image';
      mimeType: RecipeMediaImageMime;
      width: number;
      height: number;
    }
  | { ok: true; kind: 'video'; mimeType: RecipeMediaVideoMime }
  | {
      ok: false;
      reason:
        | 'unsupported_type'
        | 'too_large'
        | 'dimensions_unreadable'
        | 'dimension_exceeded';
    };

function readU32BE(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function readU16BE(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function readU24LE(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}
function readU16LE(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function ascii(b: Uint8Array, o: number, len: number): string {
  return String.fromCharCode(...b.subarray(o, o + len));
}

/** PNG: 8-byte signature, then the IHDR chunk carries width/height at 16/20. */
function sniffPng(b: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v)) return null;
  if (ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: readU32BE(b, 16), height: readU32BE(b, 20) };
}

/** JPEG: FF D8 start, dimensions in the first SOF0–SOF15 frame marker. */
function sniffJpeg(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1]!;
    // Standalone markers without a length payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = readU16BE(b, offset + 2);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 && // DHT
      marker !== 0xc8 && // JPG extension
      marker !== 0xcc; // DAC
    if (isSof) {
      return {
        height: readU16BE(b, offset + 5),
        width: readU16BE(b, offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** WebP: RIFF….WEBP, then VP8 (lossy), VP8L (lossless) or VP8X (extended). */
function sniffWebp(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') {
    return null;
  }
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') {
    return {
      width: readU24LE(b, 24) + 1,
      height: readU24LE(b, 27) + 1,
    };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    // 14-bit width-1 and height-1 packed little-endian after the signature.
    const raw = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return {
      width: (raw & 0x3fff) + 1,
      height: ((raw >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    // Lossy bitstream: 3-byte frame tag, then 3-byte start code 9D 01 2A.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return {
      width: readU16LE(b, 26) & 0x3fff,
      height: readU16LE(b, 28) & 0x3fff,
    };
  }
  return null;
}

/** MP4/QuickTime family: a top-level `ftyp` box right after the 4-byte size. */
function isMp4(b: Uint8Array): boolean {
  return b.length >= 12 && ascii(b, 4, 4) === 'ftyp';
}

/** WebM/Matroska: EBML header signature. */
function isWebm(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    b[0] === 0x1a &&
    b[1] === 0x45 &&
    b[2] === 0xdf &&
    b[3] === 0xa3
  );
}

/**
 * Validate the leading bytes of an uploaded object against the declared kind.
 * `byteSize` is the TOTAL object size (the sniff buffer may be shorter).
 */
export function validateRecipeMediaBytes(
  bytes: Uint8Array,
  byteSize: number,
  expectedKind: 'image' | 'video',
): MediaValidationResult {
  if (expectedKind === 'image') {
    if (byteSize > RECIPE_MEDIA_IMAGE_MAX_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
    const candidates: {
      mimeType: RecipeMediaImageMime;
      sniff: (b: Uint8Array) => { width: number; height: number } | null;
      matches: (b: Uint8Array) => boolean;
    }[] = [
      {
        mimeType: 'image/png',
        sniff: sniffPng,
        matches: (b) => b[0] === 0x89 && b[1] === 0x50,
      },
      {
        mimeType: 'image/jpeg',
        sniff: sniffJpeg,
        matches: (b) => b[0] === 0xff && b[1] === 0xd8,
      },
      {
        mimeType: 'image/webp',
        sniff: sniffWebp,
        matches: (b) => ascii(b, 0, 4) === 'RIFF',
      },
    ];
    const match = candidates.find((c) => bytes.length >= 2 && c.matches(bytes));
    if (!match) return { ok: false, reason: 'unsupported_type' };
    const dims = match.sniff(bytes);
    if (!dims || dims.width <= 0 || dims.height <= 0) {
      return { ok: false, reason: 'dimensions_unreadable' };
    }
    if (
      dims.width > RECIPE_MEDIA_MAX_DIMENSION_PX ||
      dims.height > RECIPE_MEDIA_MAX_DIMENSION_PX
    ) {
      return { ok: false, reason: 'dimension_exceeded' };
    }
    return { ok: true, kind: 'image', mimeType: match.mimeType, ...dims };
  }

  if (byteSize > RECIPE_MEDIA_VIDEO_MAX_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  if (isMp4(bytes)) return { ok: true, kind: 'video', mimeType: 'video/mp4' };
  if (isWebm(bytes)) return { ok: true, kind: 'video', mimeType: 'video/webm' };
  return { ok: false, reason: 'unsupported_type' };
}
