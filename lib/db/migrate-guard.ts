/**
 * Guard against the drizzle-kit migration-timestamp GOTCHA.
 *
 * The migrator applies a journal entry only when its `when` (folderMillis) is
 * STRICTLY GREATER than the max `created_at` already recorded in
 * `drizzle.__drizzle_migrations`. A hand-authored migration with an inflated
 * future `when` (0003 carries 1781600100000) therefore makes any LATER migration
 * with a smaller `when` get **silently skipped** — the command still prints
 * success, but the SQL never runs. This cost prod outages on 0006 and 0008.
 *
 * `findSkippableMigrations` is a pure function so it can be unit-tested without a
 * database; `scripts/migrate.ts` runs it before migrating and aborts loudly when
 * any entry would be skipped, telling the operator to bump the entry's `when` in
 * `drizzle/meta/_journal.json`. See memory `stack-decisions` for the full story.
 */

/** A single entry from `drizzle/meta/_journal.json`. */
export type JournalEntry = {
  idx: number;
  tag: string;
  /** Generation timestamp (ms); the migrator compares this against created_at. */
  when: number;
};

/** A journal entry the migrator would silently skip, with the threshold it failed. */
export type SkippableMigration = {
  tag: string;
  when: number;
  /** Max `created_at` already applied — the entry's `when` must exceed this. */
  maxAppliedWhen: number;
};

/**
 * Returns the journal entries that would be SILENTLY SKIPPED on the next migrate:
 * entries not yet applied whose `when` is at or below the max already-applied
 * `created_at`. On a fresh database (nothing applied) every entry runs in idx
 * order, so there is nothing to flag.
 *
 * @param entries       parsed `_journal.json` entries
 * @param appliedWhens  the `created_at` values from `drizzle.__drizzle_migrations`
 */
export function findSkippableMigrations(
  entries: JournalEntry[],
  appliedWhens: number[],
): SkippableMigration[] {
  if (appliedWhens.length === 0) return [];

  const applied = new Set(appliedWhens);
  const maxAppliedWhen = Math.max(...appliedWhens);

  return entries
    .filter((e) => !applied.has(e.when) && e.when <= maxAppliedWhen)
    .map((e) => ({ tag: e.tag, when: e.when, maxAppliedWhen }));
}

/** Human-readable abort message for one or more skippable entries. */
export function describeSkippable(skippable: SkippableMigration[]): string {
  const lines = skippable.map(
    (s) =>
      `  • ${s.tag} (when=${s.when}) ≤ max applied created_at (${s.maxAppliedWhen})`,
  );
  const fix = skippable
    .map(
      (s) =>
        `bump "${s.tag}" in drizzle/meta/_journal.json to a "when" > ${s.maxAppliedWhen}`,
    )
    .join('; ');
  return [
    'Refusing to migrate: the following journal entries would be SILENTLY SKIPPED',
    'because their "when" is not greater than the max already-applied created_at:',
    ...lines,
    '',
    `Fix: ${fix}, then re-run npm run db:migrate.`,
    'See the migration-timestamp GOTCHA in memory/stack-decisions.',
  ].join('\n');
}
