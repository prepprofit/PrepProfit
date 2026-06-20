import { describe, it, expect } from 'vitest';
import {
  inspectImage,
  validateImageUpload,
  MAX_IMAGE_BYTES,
} from './image';

/**
 * Image-validation tests (Sprint 4.7). Hand-crafted byte fixtures (just enough
 * header for the sniffer) — no real image files. Focus: the bytes, not the declared
 * mime, decide the type, so spoofed uploads (a PDF as image/png) are rejected.
 */

/** Minimal PNG: 8-byte signature + an IHDR chunk with BE width/height. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Minimal JPEG: SOI + an SOF0 frame header carrying BE height/width. */
function jpeg(width: number, height: number): Buffer {
  const b = Buffer.alloc(11);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(0x0011, 4); // segment length
  b[6] = 8; // precision
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

/** Minimal WebP (VP8X extended): RIFF/WEBP + 24-bit LE canvas dims minus one. */
function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff;
  return b;
}

describe('inspectImage — sniffs format + dimensions from magic bytes', () => {
  it('reads PNG dimensions', () => {
    expect(inspectImage(png(800, 600))).toEqual({ format: 'png', width: 800, height: 600 });
  });
  it('reads JPEG dimensions', () => {
    expect(inspectImage(jpeg(1024, 768))).toEqual({ format: 'jpeg', width: 1024, height: 768 });
  });
  it('reads WebP (VP8X) dimensions', () => {
    expect(inspectImage(webp(1024, 768))).toEqual({ format: 'webp', width: 1024, height: 768 });
  });
  it('returns null for non-image bytes (e.g. a PDF)', () => {
    expect(inspectImage(Buffer.from('%PDF-1.7\n...', 'ascii'))).toBeNull();
  });
});

describe('validateImageUpload', () => {
  it('accepts a well-formed JPEG and returns the trusted (sniffed) mime', () => {
    const result = validateImageUpload(jpeg(1200, 900), 'image/jpeg');
    expect(result).toEqual({ ok: true, mime: 'image/jpeg', width: 1200, height: 900 });
  });

  it('rejects an empty upload', () => {
    expect(validateImageUpload(Buffer.alloc(0), 'image/png')).toMatchObject({
      ok: false,
      reason: 'EMPTY',
    });
  });

  it('rejects an oversized upload before sniffing', () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    expect(validateImageUpload(big, 'image/png')).toMatchObject({ ok: false, reason: 'TOO_LARGE' });
  });

  it('rejects a PDF disguised with an image mime (anti-spoof)', () => {
    const pdf = Buffer.from('%PDF-1.7 fake', 'ascii');
    expect(validateImageUpload(pdf, 'image/png')).toMatchObject({
      ok: false,
      reason: 'UNSUPPORTED_TYPE',
    });
  });

  it('rejects when the declared mime disagrees with the bytes', () => {
    expect(validateImageUpload(png(800, 600), 'image/jpeg')).toMatchObject({
      ok: false,
      reason: 'MIME_MISMATCH',
    });
  });

  it('tolerates a mime with charset/parameters', () => {
    expect(validateImageUpload(png(800, 600), 'image/png; charset=binary')).toMatchObject({
      ok: true,
      mime: 'image/png',
    });
  });

  it('rejects a degenerate (too-small) image', () => {
    expect(validateImageUpload(png(8, 8), 'image/png')).toMatchObject({
      ok: false,
      reason: 'BAD_DIMENSIONS',
    });
  });

  it('rejects an absurdly large canvas', () => {
    expect(validateImageUpload(png(20_000, 20_000), 'image/png')).toMatchObject({
      ok: false,
      reason: 'BAD_DIMENSIONS',
    });
  });
});
