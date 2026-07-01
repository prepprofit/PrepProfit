import { describe, expect, it } from 'vitest';
import { declaredBodyExceeds, MULTIPART_OVERHEAD_BYTES } from './request-size';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://test/upload', {
    method: 'POST',
    headers,
    body: new Uint8Array(1),
  });
}

describe('declaredBodyExceeds (pre-parse upload guard, audit F3)', () => {
  it('rejects a declared length over the cap', () => {
    expect(declaredBodyExceeds(req({ 'content-length': '1001' }), 1000)).toBe(true);
  });

  it('accepts a declared length at or under the cap', () => {
    expect(declaredBodyExceeds(req({ 'content-length': '1000' }), 1000)).toBe(false);
    expect(declaredBodyExceeds(req({ 'content-length': '1' }), 1000)).toBe(false);
    expect(declaredBodyExceeds(req({ 'content-length': '0' }), 1000)).toBe(false);
  });

  it('lets a missing header through (platform cap + post-parse validators own it)', () => {
    const r = new Request('http://test/upload', { method: 'POST' });
    expect(declaredBodyExceeds(r, 1000)).toBe(false);
  });

  it('lets a malformed header through for the parser to reject', () => {
    expect(declaredBodyExceeds(req({ 'content-length': 'huge' }), 1000)).toBe(false);
  });

  it('exposes a sane multipart overhead allowance', () => {
    expect(MULTIPART_OVERHEAD_BYTES).toBeGreaterThan(0);
    expect(MULTIPART_OVERHEAD_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });
});
