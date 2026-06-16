import { describe, expect, it } from 'vitest';
import {
  findSkippableMigrations,
  describeSkippable,
  type JournalEntry,
} from './migrate-guard';

const entry = (idx: number, when: number): JournalEntry => ({
  idx,
  when,
  tag: `${String(idx).padStart(4, '0')}_m${idx}`,
});

describe('findSkippableMigrations', () => {
  it('flags nothing on a fresh database (no applied migrations)', () => {
    const entries = [entry(0, 100), entry(1, 50), entry(2, 200)];
    expect(findSkippableMigrations(entries, [])).toEqual([]);
  });

  it('flags nothing when every new entry`s when exceeds the applied max', () => {
    const entries = [entry(0, 100), entry(1, 200), entry(2, 300)];
    // 0 and 1 applied (max 200); entry 2 (when 300) is safely above.
    expect(findSkippableMigrations(entries, [100, 200])).toEqual([]);
  });

  it('flags an unapplied entry whose when is below the applied max (the gotcha)', () => {
    // 0003-style: an inflated future entry (when 999) already applied, then a new
    // entry (when 300) generated with a smaller real timestamp.
    const entries = [entry(0, 100), entry(1, 999), entry(2, 300)];
    const skippable = findSkippableMigrations(entries, [100, 999]);
    expect(skippable).toEqual([{ tag: '0002_m2', when: 300, maxAppliedWhen: 999 }]);
  });

  it('flags an entry one tick below the applied max (boundary)', () => {
    const entries = [entry(0, 100), entry(1, 500), entry(2, 499)];
    const skippable = findSkippableMigrations(entries, [100, 500]);
    expect(skippable.map((s) => s.tag)).toEqual(['0002_m2']);
  });

  it('treats a when that ties an applied when as applied (never collides in practice)', () => {
    // Real migrations always carry distinct millisecond timestamps; a tie is
    // indistinguishable from the applied row by `when`, so it is not flagged.
    const entries = [entry(0, 100), entry(1, 500), entry(2, 500)];
    expect(findSkippableMigrations(entries, [100, 500])).toEqual([]);
  });

  it('treats an entry already recorded (when in applied set) as applied', () => {
    const entries = [entry(0, 100), entry(1, 200)];
    expect(findSkippableMigrations(entries, [100, 200])).toEqual([]);
  });

  it('flags multiple skippable entries at once', () => {
    const entries = [entry(0, 1000), entry(1, 300), entry(2, 400)];
    const skippable = findSkippableMigrations(entries, [1000]);
    expect(skippable.map((s) => s.tag)).toEqual(['0001_m1', '0002_m2']);
  });
});

describe('describeSkippable', () => {
  it('names the tag, threshold, and the bump instruction', () => {
    const msg = describeSkippable([
      { tag: '0009_finance', when: 300, maxAppliedWhen: 999 },
    ]);
    expect(msg).toContain('0009_finance');
    expect(msg).toContain('999');
    expect(msg).toContain('drizzle/meta/_journal.json');
  });
});
