import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBlockedIp, loadSafeLogo } from './logo';

/**
 * SSRF/DoS guards for the server-side logo loader (Sprint 3.5A review fix). A
 * manager-supplied https URL must never let the PDF route reach a private/internal
 * address or buffer an unbounded body; every unsafe/failed case degrades to "no
 * logo" (null) rather than throwing.
 */

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

describe('isBlockedIp', () => {
  it('blocks loopback / private / link-local / CGNAT / reserved', () => {
    for (const ip of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '198.18.0.1',
      '224.0.0.1', // multicast
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      'not-an-ip',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['1.2.3.4', '8.8.8.8', '93.184.216.34', '2606:2800:220:1::1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

function imageResponse(bytes: Uint8Array, headers: Record<string, string>) {
  return new Response(bytes as unknown as BodyInit, { status: 200, headers });
}

describe('loadSafeLogo', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for empty/invalid/non-https URLs without resolving or fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await loadSafeLogo(null)).toBeNull();
    expect(await loadSafeLogo('')).toBeNull();
    expect(await loadSafeLogo('not a url')).toBeNull();
    expect(await loadSafeLogo('http://example.com/logo.png')).toBeNull();
    expect(await loadSafeLogo('data:image/png;base64,AAAA')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('refuses a host that resolves to a private/metadata IP (no fetch)', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await loadSafeLogo('https://evil.example.com/logo.png')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses when DNS resolution fails', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await loadSafeLogo('https://nope.example.com/logo.png')).toBeNull();
  });

  it('rejects a disallowed content-type', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      imageResponse(new Uint8Array([1, 2, 3]), { 'content-type': 'text/html' }),
    );
    expect(await loadSafeLogo('https://cdn.example.com/page.html')).toBeNull();
  });

  it('rejects an oversized body declared via content-length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      imageResponse(new Uint8Array([1, 2, 3]), {
        'content-type': 'image/png',
        'content-length': String(5_000_000),
      }),
    );
    expect(await loadSafeLogo('https://cdn.example.com/huge.png')).toBeNull();
  });

  it('rejects an oversized streamed body with no content-length', async () => {
    const big = new Uint8Array(2_100_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    expect(await loadSafeLogo('https://cdn.example.com/stream.png')).toBeNull();
  });

  it('returns null when the fetch throws (e.g. a blocked redirect or timeout)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('redirect not allowed'));
    expect(await loadSafeLogo('https://cdn.example.com/logo.png')).toBeNull();
  });

  it('embeds a valid image as a base64 data URI', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // "\x89PNG"
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      imageResponse(png, { 'content-type': 'image/png' }),
    );
    const result = await loadSafeLogo('https://cdn.example.com/logo.png');
    expect(result).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  });
});
