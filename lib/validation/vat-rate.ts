/**
 * A typed VAT percentage → basis points. Blank = not set (null); "14", "13,5",
 * "0" are rates; anything else, negative, above 100 or finer than 0.01% is invalid.
 */
export function parseVatPercent(text: string): number | null | 'invalid' {
  const trimmed = text.trim().replace(/%$/, '').trim().replace(',', '.');
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return 'invalid';
  const bps = Math.round(Number(trimmed) * 100);
  return bps >= 0 && bps <= 10_000 ? bps : 'invalid';
}
