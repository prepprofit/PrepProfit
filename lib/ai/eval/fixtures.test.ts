import { describe, expect, it } from 'vitest';
import { loadFixtures, loadManifest, orphanFixtureFiles } from './fixtures';

/**
 * Guards the COMMITTED eval set (golden JSON + manifest). It does NOT need any real
 * image — a missing private photo is the expected state in CI; the loader reports it
 * as `missing_image` rather than throwing. This keeps the eval fixtures honest (valid
 * schema, manifest/fixtures in sync) without the live provider.
 */

describe('eval fixtures — committed set is valid and in sync', () => {
  it('loads + validates every manifest fixture', () => {
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(f.expected.slug).toBeTruthy();
      expect(f.expected.lines.length).toBeGreaterThan(0);
    }
  });

  it('has no orphan fixture files (every golden is referenced by the manifest)', () => {
    expect(orphanFixtureFiles()).toEqual([]);
  });

  it('reports missing private images softly, never throws', () => {
    const fixtures = loadFixtures();
    for (const f of fixtures) {
      // In CI the real photos are absent (gitignored); a present image is also fine.
      expect(['ok', 'unpinned', 'missing_image']).toContain(f.integrity.state);
    }
  });

  it('manifest is well-formed', () => {
    const entries = loadManifest();
    expect(entries.some((e) => e.slug === 'baklava')).toBe(true);
  });
});

describe('Baklava golden — mandatory fixture (§9.2 / §15)', () => {
  const baklava = () => {
    const f = loadFixtures().find((x) => x.expected.slug === 'baklava');
    if (!f) throw new Error('baklava fixture missing');
    return f.expected;
  };

  it('has 11 active lines and 1 crossed-out (ignored) line', () => {
    const lines = baklava().lines;
    const active = lines.filter((l) => l.expectedStatus !== 'ignored');
    const ignored = lines.filter((l) => l.expectedStatus === 'ignored');
    expect(active).toHaveLength(11);
    expect(ignored).toHaveLength(1);
  });

  it('sections water, honey, caster sugar, and cinnamon sticks under Syrup', () => {
    const bySyrup = baklava()
      .lines.filter((l) => l.section === 'Syrup')
      .map((l) => l.name);
    expect(bySyrup).toEqual(
      expect.arrayContaining(['Water', 'Honey', 'Caster sugar', 'Cinnamon sticks']),
    );
  });

  it('expects the package-descriptor lines to need review', () => {
    const review = baklava()
      .lines.filter((l) => l.expectedStatus === 'needs_review')
      .map((l) => l.name);
    expect(review).toEqual(
      expect.arrayContaining(['Phyllo pastry', 'Walnuts', 'Cloves', 'Cinnamon sticks']),
    );
  });

  it('expects the tbsp/tsp lines to be ready', () => {
    const honey = baklava().lines.find((l) => l.name === 'Honey')!;
    const cinnamon = baklava().lines.find((l) => l.name === 'Cinnamon')!;
    expect(honey.unitToken).toBe('tbsp');
    expect(honey.expectedStatus).toBe('ready');
    expect(cinnamon.unitToken).toBe('tsp');
    expect(cinnamon.expectedStatus).toBe('ready');
  });
});
