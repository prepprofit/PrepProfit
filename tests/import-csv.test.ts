import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/import/csv';

describe('parseCsv — RFC 4180 reader', () => {
  it('parses a simple grid', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles CRLF and LF line endings identically', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual(parseCsv('a,b\n1,2\n'));
  });

  it('does not emit a spurious empty row for a trailing newline', () => {
    expect(parseCsv('a\n1\n')).toEqual([['a'], ['1']]);
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿name,price\nFlour,1.20')).toEqual([
      ['name', 'price'],
      ['Flour', '1.20'],
    ]);
  });

  it('keeps commas and newlines inside quoted fields', () => {
    expect(parseCsv('name,note\n"Flour, T55","line1\nline2"')).toEqual([
      ['name', 'note'],
      ['Flour, T55', 'line1\nline2'],
    ]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsv('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']]);
  });

  it('preserves a formula-looking value as a LITERAL string (never evaluated)', () => {
    const rows = parseCsv('note\n=1+2\n+CMD()\n@SUM(A1)\n-2');
    expect(rows).toEqual([['note'], ['=1+2'], ['+CMD()'], ['@SUM(A1)'], ['-2']]);
  });

  it('returns an empty matrix for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('keeps empty trailing fields', () => {
    expect(parseCsv('a,b,c\n1,,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });
});
