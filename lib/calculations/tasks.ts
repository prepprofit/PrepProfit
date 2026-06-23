import type { TaskStatus } from '@/lib/db/schema';

/**
 * Kitchen task pure helpers (Sprint 6). Money-free — there is NO cost/price/margin
 * here, by design (kitchen task lists never touch money). The only derivation a
 * list view needs is the progress rollup shown on the /tasks cards and as the ⌘K
 * subtitle.
 */

export type TaskListProgress = {
  done: number;
  total: number;
  /** True only when there is at least one task and every task is done. */
  allDone: boolean;
};

/**
 * Count done vs. total over a list's tasks. An empty list is `0/0` and NOT
 * "allDone" (nothing to do is not "done"). Pure + total-order independent.
 */
export function taskListProgress(
  tasks: readonly { status: TaskStatus }[],
): TaskListProgress {
  const total = tasks.length;
  const done = tasks.reduce((n, t) => (t.status === 'done' ? n + 1 : n), 0);
  return { done, total, allDone: total > 0 && done === total };
}
