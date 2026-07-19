/** Postgres SQLSTATE codes. */
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_UNIQUE_VIOLATION = '23505';

function hasCode(err: unknown, code: string): boolean {
  // Drizzle wraps driver errors (DrizzleQueryError) with the Postgres error as
  // `.cause`, so walk the cause chain looking for the SQLSTATE (bounded — a
  // cause cycle must not hang the error path).
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * True when an error is a Postgres foreign-key violation (e.g. deleting a row
 * still referenced by an `ON DELETE restrict` FK). Driver errors carry `.code`.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasCode(err, PG_FOREIGN_KEY_VIOLATION);
}

/** True when an error is a Postgres unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return hasCode(err, PG_UNIQUE_VIOLATION);
}
