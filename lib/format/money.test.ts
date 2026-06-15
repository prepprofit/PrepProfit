import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoneyToCents } from './money';

describe('formatMoney', () => {
  it('formats integer cents in the major unit', () => {
    expect(formatMoney(1234, 'EUR')).toBe('€12.34');
    expect(formatMoney(1234, 'USD')).toBe('$12.34');
    expect(formatMoney(1234, 'GBP')).toBe('£12.34');
  });

  it('formats zero', () => {
    expect(formatMoney(0, 'USD')).toBe('$0.00');
  });

  it('groups thousands', () => {
    expect(formatMoney(100000, 'USD')).toBe('$1,000.00');
    expect(formatMoney(123456789, 'EUR')).toBe('€1,234,567.89');
  });

  it('formats negative amounts', () => {
    expect(formatMoney(-500, 'USD')).toBe('-$5.00');
  });

  it('respects a currency with no minor unit (JPY)', () => {
    // JPY has zero fraction digits; Intl rounds the major value accordingly.
    expect(formatMoney(1200, 'JPY')).toBe('¥12');
  });
});

describe('parseMoneyToCents', () => {
  it('parses a plain decimal', () => {
    expect(parseMoneyToCents('12.34')).toBe(1234);
    expect(parseMoneyToCents('5')).toBe(500);
    expect(parseMoneyToCents('0')).toBe(0);
  });

  it('parses a comma decimal separator', () => {
    expect(parseMoneyToCents('12,34')).toBe(1234);
  });

  it('parses grouped values with either convention', () => {
    expect(parseMoneyToCents('1,234.56')).toBe(123456);
    expect(parseMoneyToCents('1.234,56')).toBe(123456);
  });

  it('ignores currency symbols and whitespace', () => {
    expect(parseMoneyToCents('  €9.99 ')).toBe(999);
    expect(parseMoneyToCents('$ 1,000.00')).toBe(100000);
  });

  it('rounds sub-cent input to the nearest cent', () => {
    expect(parseMoneyToCents('9.999')).toBe(1000);
    expect(parseMoneyToCents('0.1')).toBe(10);
    expect(parseMoneyToCents('19.9')).toBe(1990);
  });

  it('returns 0 for empty or unparseable input', () => {
    expect(parseMoneyToCents('')).toBe(0);
    expect(parseMoneyToCents('   ')).toBe(0);
    expect(parseMoneyToCents('abc')).toBe(0);
  });

  it('round-trips through formatMoney for common amounts', () => {
    expect(formatMoney(parseMoneyToCents('49.95'), 'EUR')).toBe('€49.95');
  });
});
