import { describe, expect, it } from 'vitest';
import { neutralizeFormula, toCsv, transactionsToCsv } from './csv';

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

describe('neutralizeFormula', () => {
  // A spreadsheet treats a cell starting with any of these as a formula.
  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'prefixes a quote when the value starts with %j',
    (lead) => {
      expect(neutralizeFormula(`${lead}cmd`)).toBe(`'${lead}cmd`);
    },
  );

  it('leaves plain text untouched', () => {
    expect(neutralizeFormula('Food sales')).toBe('Food sales');
    // Only the FIRST character matters — an interior sign is harmless.
    expect(neutralizeFormula('a=b')).toBe('a=b');
    expect(neutralizeFormula('')).toBe('');
  });
});

describe('transactionsToCsv', () => {
  it('neutralizes formula-leading user text in category/recipe/note', () => {
    const csv = transactionsToCsv([
      {
        occurredOn: '2026-06-12',
        type: 'expense',
        categoryName: '=SUM(A1:A9)',
        recipeName: '+budget',
        amountCents: 500,
        note: '@cmd',
      },
    ]);
    expect(csv).toBe(
      [
        'date,type,category,recipe,amount,note',
        // Each user field gains a leading quote so it renders as literal text.
        "2026-06-12,expense,'=SUM(A1:A9),'+budget,5.00,'@cmd",
      ].join('\r\n'),
    );
  });


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
