import readXlsxFile from 'read-excel-file/node';

/**
 * XLSX READER seam (Sprint 4.5). One thin wrapper over `read-excel-file` (Node
 * build) — the read counterpart to `lib/documents/xlsx.ts` (which writes). If the
 * reader ever needs swapping, it happens only here.
 *
 * SECURITY: `read-excel-file` parses the worksheet XML and returns CACHED cell
 * VALUES; it never evaluates formulas and never runs macros (VBA lives in
 * `.xlsm` / `vbaProject.bin`, which we reject at the action layer by accepting
 * `.xlsx`/`.csv` only). A cell whose text is `=cmd()` comes back as the literal
 * string — formula-injection safe on the read path.
 *
 * Every cell is normalized to a TRIMMED string so the downstream entity parser
 * treats CSV and XLSX identically. A real Excel date cell (a `Date`) becomes a
 * canonical `YYYY-MM-DD` (UTC, no time); numbers become their plain string form
 * (the money/quantity parsers re-interpret them).
 */

function cellToString(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).trim();
}

/**
 * Read the first worksheet of an `.xlsx` buffer into a string matrix. Reads only
 * the first sheet (the templates are single-sheet); unknown extra sheets are
 * ignored, never executed.
 */
export async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const rows = (await readXlsxFile(buffer)) as unknown[][];
  return rows.map((r) => r.map(cellToString));
}
