/**
 * Minimal, dependency-free CSV READER (RFC 4180) — the symmetric counterpart to
 * the writer in `lib/finance/csv.ts`. Returns a matrix of raw string cells.
 *
 * SECURITY: this reader NEVER evaluates a cell. A value like `=cmd()`, `+x`, or
 * `@SUM(...)` is returned verbatim as a literal string — formula injection is a
 * spreadsheet-application concern on the WRITE/display path (handled by
 * `neutralizeFormula`), and on the READ path we simply never interpret it.
 *
 * Handles quoted fields, escaped quotes (`""`), commas and newlines embedded in
 * quotes, a UTF-8 BOM, and both LF and CRLF endings. A trailing newline does not
 * yield a spurious empty final row. Cells are returned untrimmed; the entity
 * parser trims and interprets them.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Track whether the current row has seen any content, so a final flush after a
  // trailing newline does not emit an empty row.
  let started = false;
  let i = input.charCodeAt(0) === 0xfeff ? 1 : 0; // strip a leading BOM

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      started = true;
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      endRow();
      i += input[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    started = true;
    field += ch;
    i += 1;
  }

  // Flush a final unterminated row (input that did not end on a newline).
  if (started || field !== '') endRow();
  return rows;
}
