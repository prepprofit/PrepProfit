import { describe, expect, it } from 'vitest';
import { toCsv, transactionsToCsv } from './csv';

describe('toCsv', () => {
  it('joins headers and rows with CRLF', () => {
    expect(toCsv(['a', 'b'], [['1', '2'], ['3', '4']])).toBe('a,b\r\n1,2\r\n3,4');
  });

  it('quotes fields containing a comma, quote, or newline', () => {
    expect(toCsv(['x'], [['a,b']])).toBe('x\r\n"a,b"');
    expect(toCsv(['x'], [['a"b']])).toBe('x\r\n"a""b"');
    expect(toCsv(['x'], [['a\nb']])).toBe('x\r\n"a\nb"');
  });
});

describe('transactionsToCsv', () => {
  it('emits the template columns with formatted amount and blank optionals', () => {
    const csv = transactionsToCsv([
      {
        occurredOn: '2026-06-10',
        type: 'income',
        categoryName: 'Food sales',
        recipeName: 'Cake',
        amountCents: 1_250,
        note: 'lunch service',
      },
      {
        occurredOn: '2026-06-11',
        type: 'expense',
        categoryName: 'Rent',
        recipeName: null,
        amountCents: 90_000,
        note: null,
      },
    ]);
    expect(csv).toBe(
      [
        'date,type,category,recipe,amount,note',
        '2026-06-10,income,Food sales,Cake,12.50,lunch service',
        '2026-06-11,expense,Rent,,900.00,',
      ].join('\r\n'),
    );
  });
});
