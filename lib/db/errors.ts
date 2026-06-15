/** Postgres SQLSTATE for a foreign-key violation. */
const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * True when an error is a Postgres foreign-key violation (e.g. deleting a row
 * still referenced by an `ON DELETE restrict` FK). Driver errors carry `.code`.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_FOREIGN_KEY_VIOLATION
  );
}
