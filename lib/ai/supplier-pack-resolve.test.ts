import { describe, expect, it } from 'vitest';
import {
  resolveSupplierPack,
  type PackResolvableLine,
  type SupplierPackCandidate,
} from './supplier-pack-resolve';

/** A descriptor line with no package size of its own (the resolver's target case). */
const descriptorLine = (unitToken: string): PackResolvableLine => ({
  unitToken,
  packageSizeValue: null,
  packageSizeUnitToken: null,
});

const pack = (packSize: number | null, packUnit: string | null): SupplierPackCandidate => ({
  packSize,
  packUnit,
});

/* -------------------------------------------------------------------------- */
/* Resolves an unambiguous purchase-pack descriptor                            */
/* -------------------------------------------------------------------------- */

describe('resolveSupplierPack — exact, unambiguous match', () => {
  it('fills a "1 pkt" line from the ingredient\'s single supplier pack', () => {
    const res = resolveSupplierPack(descriptorLine('pkt'), [pack(300, 'g')]);
    expect(res).toEqual({ resolved: true, packageSizeValue: 300, packageSizeUnitToken: 'g' });
  });

  it('resolves a "block" descriptor (plan example: 1 block butter)', () => {
    const res = resolveSupplierPack(descriptorLine('block'), [pack(250, 'g')]);
    expect(res).toMatchObject({ resolved: true, packageSizeValue: 250, packageSizeUnitToken: 'g' });
  });

  it('collapses duplicate packs of the SAME physical size (1 kg vs 1000 g) to one', () => {
    const res = resolveSupplierPack(descriptorLine('bag'), [pack(1, 'kg'), pack(1000, 'g')]);
    // Same magnitude + dimension → not ambiguous; first candidate is applied.
    expect(res).toMatchObject({ resolved: true, packageSizeValue: 1, packageSizeUnitToken: 'kg' });
  });
});

/* -------------------------------------------------------------------------- */
/* Descriptor-word safety                                                       */
/* -------------------------------------------------------------------------- */

describe('resolveSupplierPack — only purchase-container descriptors', () => {
  it('does NOT infer a pack for a portion descriptor (3 cloves garlic)', () => {
    // Applying a 500 g garlic bag to "cloves" would cost 1.5 kg — must stay unresolved.
    const res = resolveSupplierPack(descriptorLine('clove'), [pack(500, 'g')]);
    expect(res).toEqual({ resolved: false, reason: 'NOT_PACK_DESCRIPTOR' });
  });

  it.each(['slice', 'sheet', 'leaf', 'pinch', 'stick', 'bunch'])(
    'leaves the portion descriptor %s unresolved even with a usable pack',
    (token) => {
      const res = resolveSupplierPack(descriptorLine(token), [pack(200, 'g')]);
      expect(res).toEqual({ resolved: false, reason: 'NOT_PACK_DESCRIPTOR' });
    },
  );

  it('does nothing for a true measurable unit (no inference needed)', () => {
    const res = resolveSupplierPack(descriptorLine('g'), [pack(300, 'g')]);
    expect(res).toEqual({ resolved: false, reason: 'NOT_DESCRIPTOR' });
  });

  it('does nothing for an unknown unit token', () => {
    const res = resolveSupplierPack(descriptorLine('zorp'), [pack(300, 'g')]);
    expect(res).toEqual({ resolved: false, reason: 'NOT_DESCRIPTOR' });
  });
});

/* -------------------------------------------------------------------------- */
/* Ambiguity + missing data                                                     */
/* -------------------------------------------------------------------------- */

describe('resolveSupplierPack — refuses to guess', () => {
  it('is AMBIGUOUS when two packs have different physical sizes', () => {
    const res = resolveSupplierPack(descriptorLine('bag'), [pack(300, 'g'), pack(1, 'kg')]);
    expect(res).toEqual({ resolved: false, reason: 'AMBIGUOUS_PACK' });
  });

  it('is AMBIGUOUS across dimensions (g vs ml)', () => {
    const res = resolveSupplierPack(descriptorLine('can'), [pack(400, 'g'), pack(400, 'ml')]);
    expect(res).toEqual({ resolved: false, reason: 'AMBIGUOUS_PACK' });
  });

  it('has NO_USABLE_PACK with zero candidates', () => {
    expect(resolveSupplierPack(descriptorLine('pkt'), [])).toEqual({
      resolved: false,
      reason: 'NO_USABLE_PACK',
    });
  });

  it('has NO_USABLE_PACK when packs lack a size or a measurable unit', () => {
    const res = resolveSupplierPack(descriptorLine('pkt'), [
      pack(null, 'g'), // no size
      pack(0, 'g'), // non-positive
      pack(300, null), // no unit
      pack(300, 'pkt'), // unit is itself a descriptor, not measurable
    ]);
    expect(res).toEqual({ resolved: false, reason: 'NO_USABLE_PACK' });
  });

  it('ignores unusable packs but still resolves a single usable one', () => {
    const res = resolveSupplierPack(descriptorLine('bag'), [
      pack(null, 'g'),
      pack(500, 'g'),
      pack(0, 'kg'),
    ]);
    expect(res).toMatchObject({ resolved: true, packageSizeValue: 500, packageSizeUnitToken: 'g' });
  });
});

/* -------------------------------------------------------------------------- */
/* The chef's own entry always wins                                            */
/* -------------------------------------------------------------------------- */

describe('resolveSupplierPack — never overrides a usable pack size', () => {
  it('leaves a line that already carries a usable package size untouched', () => {
    const line: PackResolvableLine = {
      unitToken: 'pkt',
      packageSizeValue: 250,
      packageSizeUnitToken: 'g',
    };
    expect(resolveSupplierPack(line, [pack(500, 'g')])).toEqual({
      resolved: false,
      reason: 'ALREADY_SIZED',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Never auto-prices                                                            */
/* -------------------------------------------------------------------------- */

describe('resolveSupplierPack — never carries a price', () => {
  it('a resolved result exposes only the pack size, never a cost', () => {
    const res = resolveSupplierPack(descriptorLine('pkt'), [pack(300, 'g')]);
    expect(res.resolved).toBe(true);
    // The resolver fills QUANTITY canonicalization only — pricing stays out of band.
    expect(Object.keys(res).sort()).toEqual(
      ['packageSizeUnitToken', 'packageSizeValue', 'resolved'].sort(),
    );
  });
});
