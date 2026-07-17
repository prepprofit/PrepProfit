import { describe, expect, it } from 'vitest';
import {
  validateRecipeMediaBytes,
  RECIPE_MEDIA_IMAGE_MAX_BYTES,
  RECIPE_MEDIA_VIDEO_MAX_BYTES,
} from '@/lib/media/validate';

/** Minimal-but-real container headers, built byte by byte. */

function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8); // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function jpegBytes(width: number, height: number): Uint8Array {
  // SOI, APP0 (skipped by the scanner), SOF0 with dimensions.
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const sof0 = [
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0]);
}

function webpVp8xBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  const w = width - 1;
  const h = height - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return b;
}

const mp4Bytes = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // size + "ftyp"
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
]);
const webmBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);

describe('validateRecipeMediaBytes', () => {
  it('accepts PNG/JPEG/WebP with real dimensions', () => {
    expect(validateRecipeMediaBytes(pngBytes(800, 600), 1000, 'image')).toEqual({
      ok: true,
      kind: 'image',
      mimeType: 'image/png',
      width: 800,
      height: 600,
    });
    expect(
      validateRecipeMediaBytes(jpegBytes(1920, 1080), 1000, 'image'),
    ).toEqual({
      ok: true,
      kind: 'image',
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1080,
    });
    expect(
      validateRecipeMediaBytes(webpVp8xBytes(640, 480), 1000, 'image'),
    ).toEqual({
      ok: true,
      kind: 'image',
      mimeType: 'image/webp',
      width: 640,
      height: 480,
    });
  });

  it('accepts MP4 and WebM containers as video', () => {
    expect(validateRecipeMediaBytes(mp4Bytes, 5000, 'video')).toEqual({
      ok: true,
      kind: 'video',
      mimeType: 'video/mp4',
    });
    expect(validateRecipeMediaBytes(webmBytes, 5000, 'video')).toEqual({
      ok: true,
      kind: 'video',
      mimeType: 'video/webm',
    });
  });

  it('rejects a mislabeled kind — real bytes decide, not the client', () => {
    // A "video" upload that is actually a PNG.
    expect(validateRecipeMediaBytes(pngBytes(10, 10), 100, 'video')).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    // An "image" upload that is actually an MP4.
    expect(validateRecipeMediaBytes(mp4Bytes, 100, 'image')).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
  });

  it('rejects garbage, truncated and oversized objects', () => {
    expect(
      validateRecipeMediaBytes(new Uint8Array([1, 2, 3]), 3, 'image'),
    ).toEqual({ ok: false, reason: 'unsupported_type' });
    // JPEG without an SOF marker in the sniff window.
    expect(
      validateRecipeMediaBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), 6, 'image'),
    ).toEqual({ ok: false, reason: 'dimensions_unreadable' });
    expect(
      validateRecipeMediaBytes(
        pngBytes(10, 10),
        RECIPE_MEDIA_IMAGE_MAX_BYTES + 1,
        'image',
      ),
    ).toEqual({ ok: false, reason: 'too_large' });
    expect(
      validateRecipeMediaBytes(mp4Bytes, RECIPE_MEDIA_VIDEO_MAX_BYTES + 1, 'video'),
    ).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects absurd dimensions', () => {
    expect(
      validateRecipeMediaBytes(pngBytes(60_000, 100), 1000, 'image'),
    ).toEqual({ ok: false, reason: 'dimension_exceeded' });
    expect(validateRecipeMediaBytes(pngBytes(0, 100), 1000, 'image')).toEqual({
      ok: false,
      reason: 'dimensions_unreadable',
    });
  });
});
