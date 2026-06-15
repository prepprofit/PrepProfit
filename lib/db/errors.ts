/** Postgres SQLSTATE codes. */
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_UNIQUE_VIOLATION = '23505';

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
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
