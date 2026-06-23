import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { ingredients, recipes, taskLists, tasks } from '@/lib/db/schema';
import type { Task, TaskList, TaskSourceKind } from '@/lib/db/schema';
import type { TenantClient } from '@/lib/db/tenant';
import { taskListProgress, type TaskListProgress } from '@/lib/calculations/tasks';

/**
 * Kitchen task lists + tasks data layer (Sprint 6). Every function is org-scoped
 * (RULE #1) and runs inside the caller's `withOrg` transaction so RLS is active.
 * MONEY-FREE end-to-end — nothing here selects or derives a price/cost/margin.
 *
 * Two freshness tokens, both the row's `updated_at` ISO string:
 *  - LIST-level mutations (update header / reset / soft-delete / reorder tasks) carry
 *    the LIST's `expectedUpdatedAt`;
 *  - TASK-level mutations (update / toggle / assign / delete) carry the TASK's
 *    `expectedUpdatedAt`.
 * EVERY child mutation also bumps the parent `task_lists.updated_at` in the same tx,
 * so list-level UIs always have one coherent freshness signal (D-lifecycle).
 *
 * Optimistic concurrency: every guarded mutation locks the row(s) `FOR UPDATE`,
 * compares the token, and returns `stale` BEFORE any write — same contract as
 * productions (`lockProductionForUpdate`). A trashed parent list refuses task edits
 * (`not_editable`).
 */

/** Per-list task cap (guards duplicate + bulk prep, mirrors the Zod cap). */
export const MAX_TASKS_PER_LIST = 500;

// ── DTOs ────────────────────────────────────────────────────────────────────

/** One task list plus its derived progress (money-free), for the /tasks rail. */
export type TaskListWithProgress = {
  id: string;
  name: string;
  notes: string | null;
  scheduledFor: string | null;
  sortOrder: number;
  /** ISO timestamp the client echoes back as the list `expectedUpdatedAt`. */
  updatedAt: string;
  progress: TaskListProgress;
};

/** One task row as both roles see it (no money — there is none). */
export type TaskView = {
  id: string;
  title: string;
  notes: string | null;
  station: string | null;
  status: Task['status'];
  assigneeUserId: string | null;
  dueOn: string | null;
  completedAt: string | null;
  completedBy: string | null;
  sourceKind: TaskSourceKind;
  sourceRecipeId: string | null;
  sourceIngredientId: string | null;
  sortOrder: number;
  /** ISO timestamp the client echoes back as the task `expectedUpdatedAt`. */
  updatedAt: string;
};

/** A list detail: the list header + its ordered tasks. */
export type TaskListDetail = {
  id: string;
  name: string;
  notes: string | null;
  scheduledFor: string | null;
  /** ISO timestamp — the coherent list-level freshness token. */
  updatedAt: string;
  tasks: TaskView[];
  progress: TaskListProgress;
};

// ── Projections ───────────────────────────────────────────────────────────────

function toTaskView(row: Task): TaskView {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    station: row.station,
    status: row.status,
    assigneeUserId: row.assigneeUserId,
    dueOn: row.dueOn,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    completedBy: row.completedBy,
    sourceKind: row.sourceKind,
    sourceRecipeId: row.sourceRecipeId,
    sourceIngredientId: row.sourceIngredientId,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Tasks of a list in display order: (sort_order, created_at, id). */
async function loadTasksForList(
  db: TenantClient,
  organizationId: string,
  listId: string,
): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.organizationId, organizationId), eq(tasks.taskListId, listId)),
    )
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt), asc(tasks.id));
}

// ── Base reads ────────────────────────────────────────────────────────────────

/**
 * Active task lists with their progress counts, in rail order:
 * (sort_order, scheduled_for NULLS LAST, created_at, id). Two batched queries.
 */
export async function listTaskLists(
  db: TenantClient,
  organizationId: string,
): Promise<TaskListWithProgress[]> {
  const lists = await db
    .select()
    .from(taskLists)
    .where(
      and(eq(taskLists.organizationId, organizationId), isNull(taskLists.deletedAt)),
    )
    .orderBy(
      asc(taskLists.sortOrder),
      sql`${taskLists.scheduledFor} asc nulls last`,
      asc(taskLists.createdAt),
      asc(taskLists.id),
    );
  if (lists.length === 0) return [];

  const statusRows = await db
    .select({ taskListId: tasks.taskListId, status: tasks.status })
    .from(tasks)
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        inArray(
          tasks.taskListId,
          lists.map((l) => l.id),
        ),
      ),
    );

  const byList = new Map<string, { status: Task['status'] }[]>();
  for (const r of statusRows) {
    const arr = byList.get(r.taskListId);
    if (arr) arr.push({ status: r.status });
    else byList.set(r.taskListId, [{ status: r.status }]);
  }

  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    notes: l.notes,
    scheduledFor: l.scheduledFor,
    sortOrder: l.sortOrder,
    updatedAt: l.updatedAt.toISOString(),
    progress: taskListProgress(byList.get(l.id) ?? []),
  }));
}

/** One active list with its ordered tasks + progress, or null. */
export async function getTaskListWithTasks(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<TaskListDetail | null> {
  const [list] = await db
    .select()
    .from(taskLists)
    .where(
      and(
        eq(taskLists.organizationId, organizationId),
        eq(taskLists.id, id),
        isNull(taskLists.deletedAt),
      ),
    )
    .limit(1);
  if (!list) return null;

  const rows = await loadTasksForList(db, organizationId, id);
  const taskViews = rows.map(toTaskView);
  return {
    id: list.id,
    name: list.name,
    notes: list.notes,
    scheduledFor: list.scheduledFor,
    updatedAt: list.updatedAt.toISOString(),
    tasks: taskViews,
    progress: taskListProgress(rows),
  };
}

/** Active task lists as lightweight picker options (id + name), rail order. */
export type TaskListOption = { id: string; name: string };

export async function listTaskListOptions(
  db: TenantClient,
  organizationId: string,
): Promise<TaskListOption[]> {
  return db
    .select({ id: taskLists.id, name: taskLists.name })
    .from(taskLists)
    .where(
      and(eq(taskLists.organizationId, organizationId), isNull(taskLists.deletedAt)),
    )
    .orderBy(
      asc(taskLists.sortOrder),
      sql`${taskLists.scheduledFor} asc nulls last`,
      asc(taskLists.createdAt),
      asc(taskLists.id),
    );
}

/** Trashed task lists (newest-trashed first), for the manager-only /trash surface. */
export async function listTrashedTaskLists(
  db: TenantClient,
  organizationId: string,
): Promise<TaskList[]> {
  return db
    .select()
    .from(taskLists)
    .where(
      and(
        eq(taskLists.organizationId, organizationId),
        isNotNull(taskLists.deletedAt),
      ),
    )
    .orderBy(sql`${taskLists.deletedAt} desc`);
}

// ── Lock helpers ──────────────────────────────────────────────────────────────

type TaskListLock =
  | { status: 'ok'; row: TaskList }
  | { status: 'not_found' }
  | { status: 'stale' };

/**
 * Lock an ACTIVE task list `FOR UPDATE` and enforce the optimistic-concurrency
 * guard. A trashed/missing list is `not_found` (active-only). When
 * `expectedUpdatedAt` is supplied, a token mismatch is `stale`.
 */
async function lockTaskListForUpdate(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt?: Date,
): Promise<TaskListLock> {
  const [row] = await db
    .select()
    .from(taskLists)
    .where(
      and(
        eq(taskLists.organizationId, organizationId),
        eq(taskLists.id, id),
        isNull(taskLists.deletedAt),
      ),
    )
    .for('update');
  if (!row) return { status: 'not_found' };
  if (
    expectedUpdatedAt &&
    row.updatedAt.getTime() !== expectedUpdatedAt.getTime()
  ) {
    return { status: 'stale' };
  }
  return { status: 'ok', row };
}

type ParentListLock =
  | { status: 'ok'; row: TaskList }
  | { status: 'not_found' }
  // The list exists but is trashed → its tasks can't be edited.
  | { status: 'not_editable' };

/**
 * Lock a task's PARENT list `FOR UPDATE` (any state), distinguishing a missing list
 * (`not_found`) from a trashed one (`not_editable`). Used by task-authoring paths
 * (add / reorder / source-task creation) so a trashed list refuses edits.
 */
async function lockParentList(
  db: TenantClient,
  organizationId: string,
  listId: string,
): Promise<ParentListLock> {
  const [row] = await db
    .select()
    .from(taskLists)
    .where(
      and(eq(taskLists.organizationId, organizationId), eq(taskLists.id, listId)),
    )
    .for('update');
  if (!row) return { status: 'not_found' };
  if (row.deletedAt !== null) return { status: 'not_editable' };
  return { status: 'ok', row };
}

type TaskLock =
  | { status: 'ok'; task: Task }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

/**
 * Lock a task AND its parent list `FOR UPDATE` (parent first, then the task, a fixed
 * cross-table order), enforcing the optimistic-concurrency guard on the TASK token.
 * A trashed parent list → `not_editable`; a missing task/list → `not_found`.
 */
async function lockTaskForUpdate(
  db: TenantClient,
  organizationId: string,
  taskId: string,
  expectedUpdatedAt: Date,
): Promise<TaskLock> {
  // Resolve the task's list id under a row lock, then lock the parent list, then the
  // task itself — the parent lock proves the list is active before any task write.
  const [taskRow] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)))
    .for('update');
  if (!taskRow) return { status: 'not_found' };

  const parent = await lockParentList(db, organizationId, taskRow.taskListId);
  if (parent.status === 'not_found') return { status: 'not_found' };
  if (parent.status === 'not_editable') return { status: 'not_editable' };

  if (taskRow.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    return { status: 'stale' };
  }
  return { status: 'ok', task: taskRow };
}

/** Bump the parent list's freshness token in the same tx as a child mutation. */
async function touchList(
  db: TenantClient,
  organizationId: string,
  listId: string,
): Promise<void> {
  await db
    .update(taskLists)
    .set({ updatedAt: new Date() })
    .where(
      and(eq(taskLists.organizationId, organizationId), eq(taskLists.id, listId)),
    );
}

async function countTasksInList(
  db: TenantClient,
  organizationId: string,
  listId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(tasks)
    .where(
      and(eq(tasks.organizationId, organizationId), eq(tasks.taskListId, listId)),
    );
  return rows[0]?.value ?? 0;
}

/** Next sort order = max(existing) + 1 (append to the end of the list). */
async function nextTaskSortOrder(
  db: TenantClient,
  organizationId: string,
  listId: string,
): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${tasks.sortOrder}), -1)` })
    .from(tasks)
    .where(
      and(eq(tasks.organizationId, organizationId), eq(tasks.taskListId, listId)),
    );
  return Number(rows[0]?.max ?? -1) + 1;
}

// ── List mutations ──────────────────────────────────────────────────────────

export type TaskListFields = {
  name: string;
  notes: string | null;
  scheduledFor: string | null;
};

/** Create an active task list (manager-only at the action layer). */
export async function createTaskList(
  db: TenantClient,
  organizationId: string,
  fields: TaskListFields,
): Promise<TaskList> {
  // Append to the end of the rail.
  const orderRows = await db
    .select({ max: sql<number>`coalesce(max(${taskLists.sortOrder}), -1)` })
    .from(taskLists)
    .where(eq(taskLists.organizationId, organizationId));
  const sortOrder = Number(orderRows[0]?.max ?? -1) + 1;

  const [row] = await db
    .insert(taskLists)
    .values({
      organizationId,
      name: fields.name,
      notes: fields.notes,
      scheduledFor: fields.scheduledFor,
      sortOrder,
    })
    .returning();
  if (!row) throw new Error('Failed to create task list.');
  return row;
}

export type UpdateTaskListOutcome =
  | { status: 'ok'; list: TaskList }
  | { status: 'not_found' }
  | { status: 'stale' };

/** Update an active list's header (name/notes/scheduledFor), optimistic-locked. */
export async function updateTaskList(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
  fields: TaskListFields,
): Promise<UpdateTaskListOutcome> {
  const lock = await lockTaskListForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  const [list] = await db
    .update(taskLists)
    .set({
      name: fields.name,
      notes: fields.notes,
      scheduledFor: fields.scheduledFor,
    })
    .where(
      and(
        eq(taskLists.organizationId, organizationId),
        eq(taskLists.id, id),
        isNull(taskLists.deletedAt),
      ),
    )
    .returning();
  if (!list) return { status: 'not_found' };
  return { status: 'ok', list };
}

/**
 * Rewrite the rail `sort_order` for the supplied list ids (manager-only). Only the
 * org's ACTIVE lists are reordered; unknown/foreign/trashed ids are ignored. Lists
 * not named keep their relative order after the named ones (their sort_order is left
 * untouched). Returns the count reordered.
 */
export async function reorderTaskLists(
  db: TenantClient,
  organizationId: string,
  orderedIds: string[],
): Promise<number> {
  if (orderedIds.length === 0) return 0;
  // Lock the named active lists in id order (deadlock-free).
  const locked = await db
    .select({ id: taskLists.id })
    .from(taskLists)
    .where(
      and(
        eq(taskLists.organizationId, organizationId),
        isNull(taskLists.deletedAt),
        inArray(taskLists.id, orderedIds),
      ),
    )
    .orderBy(asc(taskLists.id))
    .for('update');
  const lockedIds = new Set(locked.map((r) => r.id));

  let nextOrder = 0;
  for (const id of orderedIds) {
    if (!lockedIds.has(id)) continue;
    await db
      .update(taskLists)
      .set({ sortOrder: nextOrder })
      .where(
        and(eq(taskLists.organizationId, organizationId), eq(taskLists.id, id)),
      );
    nextOrder += 1;
  }
  return nextOrder;
}

export type ResetTaskListOutcome =
  | { status: 'ok'; resetCount: number }
  | { status: 'not_found' }
  | { status: 'stale' };

/**
 * Reset every task in an active list back to `open` and clear its completion stamps
 * (D4) — keeps the rows so a daily checklist can be re-run. Optimistic-locked on the
 * LIST token; bumps the list freshness token. Returns how many tasks flipped.
 */
export async function resetTaskList(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<ResetTaskListOutcome> {
  const lock = await lockTaskListForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  const reopened = await db
    .update(tasks)
    .set({ status: 'open', completedAt: null, completedBy: null })
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        eq(tasks.taskListId, id),
        eq(tasks.status, 'done'),
      ),
    )
    .returning({ id: tasks.id });

  await touchList(db, organizationId, id);
  return { status: 'ok', resetCount: reopened.length };
}

export type DuplicateTaskListOutcome =
  | { status: 'ok'; list: TaskList; taskCount: number }
  | { status: 'not_found' };

/**
 * Duplicate an active list: copy the header (name suffixed by the caller) + every
 * task as `open`, UNASSIGNED, completion cleared, source links PRESERVED (D-lifecycle
 * / L7). Manager-only. The source ≤ cap by construction, so the copy never exceeds
 * `MAX_TASKS_PER_LIST`.
 */
export async function duplicateTaskList(
  db: TenantClient,
  organizationId: string,
  id: string,
  newName: string,
): Promise<DuplicateTaskListOutcome> {
  // Lock the source active list so its tasks can't change mid-copy.
  const lock = await lockTaskListForUpdate(db, organizationId, id);
  if (lock.status !== 'ok') return { status: 'not_found' };

  const sourceTasks = await loadTasksForList(db, organizationId, id);

  const orderRows = await db
    .select({ max: sql<number>`coalesce(max(${taskLists.sortOrder}), -1)` })
    .from(taskLists)
    .where(eq(taskLists.organizationId, organizationId));
  const sortOrder = Number(orderRows[0]?.max ?? -1) + 1;

  const [list] = await db
    .insert(taskLists)
    .values({
      organizationId,
      name: newName,
      notes: lock.row.notes,
      scheduledFor: lock.row.scheduledFor,
      sortOrder,
    })
    .returning();
  if (!list) throw new Error('Failed to duplicate task list.');

  if (sourceTasks.length > 0) {
    await db.insert(tasks).values(
      sourceTasks.map((t, index) => ({
        organizationId,
        taskListId: list.id,
        title: t.title,
        notes: t.notes,
        station: t.station,
        status: 'open' as const,
        assigneeUserId: null,
        dueOn: t.dueOn,
        completedAt: null,
        completedBy: null,
        sourceKind: t.sourceKind,
        sourceRecipeId: t.sourceRecipeId,
        sourceIngredientId: t.sourceIngredientId,
        sortOrder: index,
      })),
    );
  }
  return { status: 'ok', list, taskCount: sourceTasks.length };
}

export type DeleteTaskListOutcome =
  | { status: 'ok'; list: TaskList }
  | { status: 'not_found' }
  | { status: 'stale' };

/** Soft-delete (Trash) an active list, optimistic-locked. Tasks ride along. */
export async function softDeleteTaskList(
  db: TenantClient,
  organizationId: string,
  id: string,
  expectedUpdatedAt: Date,
): Promise<DeleteTaskListOutcome> {
  const lock = await lockTaskListForUpdate(db, organizationId, id, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  const [list] = await db
    .update(taskLists)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(taskLists.organizationId, organizationId),
        eq(taskLists.id, id),
        isNull(taskLists.deletedAt),
      ),
    )
    .returning();
  if (!list) return { status: 'not_found' };
  return { status: 'ok', list };
}

/** Bring a trashed list back (manager-only). Returns null if not in the trash. */
export async function restoreTaskList(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<TaskList | null> {
  const [row] = await db
    .update(taskLists)
    .set({ deletedAt: null })
    .where(
      and(
        eq(taskLists.organizationId, organizationId),
        eq(taskLists.id, id),
        isNotNull(taskLists.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Permanently delete a trashed list; its tasks cascade via the composite FK (which
 * frees any recipe/ingredient those tasks pinned via the restrict FKs). Only trashed
 * rows are eligible.
 */
export async function purgeTaskList(
  db: TenantClient,
  organizationId: string,
  id: string,
): Promise<void> {
  await db
    .delete(taskLists)
    .where(
      and(
        eq(taskLists.organizationId, organizationId),
        eq(taskLists.id, id),
        isNotNull(taskLists.deletedAt),
      ),
    );
}

// ── Task mutations ────────────────────────────────────────────────────────────

export type TaskFields = {
  title: string;
  notes: string | null;
  station: string | null;
  dueOn: string | null;
};

export type AddTaskOutcome =
  | { status: 'ok'; task: Task }
  | { status: 'not_found' }
  | { status: 'not_editable' }
  | { status: 'full' };

/**
 * Append a manual task to an ACTIVE list (both roles, D1). Refuses a trashed list
 * (`not_editable`) and a list at the per-list cap (`full`). Bumps the list token.
 */
export async function addTask(
  db: TenantClient,
  organizationId: string,
  listId: string,
  fields: TaskFields,
): Promise<AddTaskOutcome> {
  const parent = await lockParentList(db, organizationId, listId);
  if (parent.status === 'not_found') return { status: 'not_found' };
  if (parent.status === 'not_editable') return { status: 'not_editable' };

  if ((await countTasksInList(db, organizationId, listId)) >= MAX_TASKS_PER_LIST) {
    return { status: 'full' };
  }
  const sortOrder = await nextTaskSortOrder(db, organizationId, listId);

  const [task] = await db
    .insert(tasks)
    .values({
      organizationId,
      taskListId: listId,
      title: fields.title,
      notes: fields.notes,
      station: fields.station,
      dueOn: fields.dueOn,
      sourceKind: 'manual',
      sortOrder,
    })
    .returning();
  if (!task) throw new Error('Failed to add task.');

  await touchList(db, organizationId, listId);
  return { status: 'ok', task };
}

export type TaskMutationOutcome =
  | { status: 'ok'; task: Task; listId: string }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

/** Edit a task's title/notes/station/due (both roles, D1), optimistic-locked. */
export async function updateTask(
  db: TenantClient,
  organizationId: string,
  taskId: string,
  expectedUpdatedAt: Date,
  fields: TaskFields,
): Promise<TaskMutationOutcome> {
  const lock = await lockTaskForUpdate(db, organizationId, taskId, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  const [task] = await db
    .update(tasks)
    .set({
      title: fields.title,
      notes: fields.notes,
      station: fields.station,
      dueOn: fields.dueOn,
    })
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)))
    .returning();
  if (!task) return { status: 'not_found' };

  await touchList(db, organizationId, task.taskListId);
  return { status: 'ok', task, listId: task.taskListId };
}

export type ToggleTaskOutcome =
  | { status: 'ok'; task: Task; listId: string; changed: boolean }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

/**
 * Toggle a task's status (both roles). `done=true` stamps `completed_at=now()` +
 * `completed_by=actorUserId`; `done=false` clears both. IDEMPOTENT — re-applying the
 * current status is a no-op that does not re-stamp, re-bump or re-audit (`changed:
 * false`). Optimistic-locked on the TASK token.
 */
export async function toggleTask(
  db: TenantClient,
  organizationId: string,
  taskId: string,
  expectedUpdatedAt: Date,
  done: boolean,
  actorUserId: string,
): Promise<ToggleTaskOutcome> {
  const lock = await lockTaskForUpdate(db, organizationId, taskId, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  const desired: Task['status'] = done ? 'done' : 'open';
  if (lock.task.status === desired) {
    // Idempotent no-op — nothing written, list token unchanged, no audit.
    return { status: 'ok', task: lock.task, listId: lock.task.taskListId, changed: false };
  }

  const [task] = await db
    .update(tasks)
    .set(
      done
        ? { status: 'done', completedAt: new Date(), completedBy: actorUserId }
        : { status: 'open', completedAt: null, completedBy: null },
    )
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)))
    .returning();
  if (!task) return { status: 'not_found' };

  await touchList(db, organizationId, task.taskListId);
  return { status: 'ok', task, listId: task.taskListId, changed: true };
}

/**
 * Set or clear a task's assignee (manager-only at the action layer; the action has
 * already validated the id is an active Clerk org member). `assigneeUserId = null`
 * clears it. Optimistic-locked on the TASK token. Bumps the list token.
 */
export async function assignTask(
  db: TenantClient,
  organizationId: string,
  taskId: string,
  expectedUpdatedAt: Date,
  assigneeUserId: string | null,
): Promise<TaskMutationOutcome> {
  const lock = await lockTaskForUpdate(db, organizationId, taskId, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  const [task] = await db
    .update(tasks)
    .set({ assigneeUserId })
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)))
    .returning();
  if (!task) return { status: 'not_found' };

  await touchList(db, organizationId, task.taskListId);
  return { status: 'ok', task, listId: task.taskListId };
}

export type ReorderTasksOutcome =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

/**
 * Rewrite `sort_order` for the supplied task ids within one active list (both roles,
 * D1). Optimistic-locked on the LIST token. Only tasks that belong to the list are
 * reordered (id-order locked, deadlock-free); unknown ids are ignored. Bumps the
 * list token.
 */
export async function reorderTasks(
  db: TenantClient,
  organizationId: string,
  listId: string,
  expectedUpdatedAt: Date,
  orderedTaskIds: string[],
): Promise<ReorderTasksOutcome> {
  const parent = await lockParentList(db, organizationId, listId);
  if (parent.status === 'not_found') return { status: 'not_found' };
  if (parent.status === 'not_editable') return { status: 'not_editable' };
  if (parent.row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    return { status: 'stale' };
  }

  if (orderedTaskIds.length > 0) {
    // Lock this list's named tasks in id order (deadlock-free); ignore foreign ids.
    const locked = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          eq(tasks.taskListId, listId),
          inArray(tasks.id, orderedTaskIds),
        ),
      )
      .orderBy(asc(tasks.id))
      .for('update');
    const lockedIds = new Set(locked.map((r) => r.id));

    let nextOrder = 0;
    for (const id of orderedTaskIds) {
      if (!lockedIds.has(id)) continue;
      await db
        .update(tasks)
        .set({ sortOrder: nextOrder })
        .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, id)));
      nextOrder += 1;
    }
  }

  await touchList(db, organizationId, listId);
  return { status: 'ok' };
}

export type DeleteTaskOutcome =
  | { status: 'ok'; listId: string }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'not_editable' };

/**
 * Hard-delete a single task row from an ACTIVE list (manager-only, D8) —
 * optimistic-locked on the TASK token. The recoverable Trash unit is the LIST, not
 * the task. A trashed parent list refuses the delete (`not_editable`). Bumps the
 * list token.
 */
export async function deleteTask(
  db: TenantClient,
  organizationId: string,
  taskId: string,
  expectedUpdatedAt: Date,
): Promise<DeleteTaskOutcome> {
  const lock = await lockTaskForUpdate(db, organizationId, taskId, expectedUpdatedAt);
  if (lock.status !== 'ok') return { status: lock.status };

  const listId = lock.task.taskListId;
  await db
    .delete(tasks)
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)));

  await touchList(db, organizationId, listId);
  return { status: 'ok', listId };
}

// ── Data-anchored integrations (L4 / D7) ──────────────────────────────────────

export type CreateSourceTaskOutcome =
  | { status: 'ok'; task: Task }
  | { status: 'not_found' }
  | { status: 'not_editable' }
  | { status: 'full' }
  // The recipe/ingredient is missing, trashed or cross-org.
  | { status: 'source_invalid' };

/**
 * Append a REORDER task anchored to a low-stock ingredient (manager-only). Locks the
 * parent list (active) + the ACTIVE ingredient (serializes vs a concurrent trash),
 * snapshots the ingredient name into the title — MONEY-FREE (never reads a price).
 */
export async function createReorderTaskFromIngredient(
  db: TenantClient,
  organizationId: string,
  listId: string,
  ingredientId: string,
): Promise<CreateSourceTaskOutcome> {
  const parent = await lockParentList(db, organizationId, listId);
  if (parent.status === 'not_found') return { status: 'not_found' };
  if (parent.status === 'not_editable') return { status: 'not_editable' };
  if ((await countTasksInList(db, organizationId, listId)) >= MAX_TASKS_PER_LIST) {
    return { status: 'full' };
  }

  const [ingredient] = await db
    .select({ id: ingredients.id, name: ingredients.name })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.organizationId, organizationId),
        eq(ingredients.id, ingredientId),
        isNull(ingredients.deletedAt),
      ),
    )
    .for('update');
  if (!ingredient) return { status: 'source_invalid' };

  const sortOrder = await nextTaskSortOrder(db, organizationId, listId);
  const [task] = await db
    .insert(tasks)
    .values({
      organizationId,
      taskListId: listId,
      title: ingredient.name,
      sourceKind: 'reorder',
      sourceIngredientId: ingredient.id,
      sortOrder,
    })
    .returning();
  if (!task) throw new Error('Failed to create reorder task.');

  await touchList(db, organizationId, listId);
  return { status: 'ok', task };
}

/**
 * Append a PREP task anchored to a recipe (both roles, D1/D7). Locks the parent list
 * (active) + the ACTIVE recipe (serializes vs a concurrent trash), snapshots the
 * recipe name into the title — MONEY-FREE (never reads cost).
 */
export async function createPrepTaskFromRecipe(
  db: TenantClient,
  organizationId: string,
  listId: string,
  recipeId: string,
): Promise<CreateSourceTaskOutcome> {
  const parent = await lockParentList(db, organizationId, listId);
  if (parent.status === 'not_found') return { status: 'not_found' };
  if (parent.status === 'not_editable') return { status: 'not_editable' };
  if ((await countTasksInList(db, organizationId, listId)) >= MAX_TASKS_PER_LIST) {
    return { status: 'full' };
  }

  const [recipe] = await db
    .select({ id: recipes.id, name: recipes.name })
    .from(recipes)
    .where(
      and(
        eq(recipes.organizationId, organizationId),
        eq(recipes.id, recipeId),
        isNull(recipes.deletedAt),
      ),
    )
    .for('update');
  if (!recipe) return { status: 'source_invalid' };

  const sortOrder = await nextTaskSortOrder(db, organizationId, listId);
  const [task] = await db
    .insert(tasks)
    .values({
      organizationId,
      taskListId: listId,
      title: recipe.name,
      sourceKind: 'prep',
      sourceRecipeId: recipe.id,
      sortOrder,
    })
    .returning();
  if (!task) throw new Error('Failed to create prep task.');

  await touchList(db, organizationId, listId);
  return { status: 'ok', task };
}

// ── Trash-purge unlink helpers (L4 / D3) ──────────────────────────────────────

/**
 * NULL the `tasks.source_recipe_id` link (→ `source_kind = 'manual'`) for every task
 * pointing at a recipe in the supplied purge set, BEFORE the recipe rows are deleted
 * — mirrors the `transactions.recipe_id` unlink (lib/data/trash.ts). The task
 * survives as plain text. `recipeIds` is the EXACT set about to be purged.
 */
export async function nullTaskRecipeLinks(
  db: TenantClient,
  organizationId: string,
  recipeIds: string[],
): Promise<void> {
  if (recipeIds.length === 0) return;
  await db
    .update(tasks)
    .set({ sourceKind: 'manual', sourceRecipeId: null })
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        isNotNull(tasks.sourceRecipeId),
        inArray(tasks.sourceRecipeId, recipeIds),
      ),
    );
}

/**
 * NULL the `tasks.source_ingredient_id` link (→ `source_kind = 'manual'`) for every
 * task pointing at an ingredient in the supplied purge set, BEFORE the ingredient
 * rows are deleted. `ingredientIds` is the EXACT set about to be purged.
 */
export async function nullTaskIngredientLinks(
  db: TenantClient,
  organizationId: string,
  ingredientIds: string[],
): Promise<void> {
  if (ingredientIds.length === 0) return;
  await db
    .update(tasks)
    .set({ sourceKind: 'manual', sourceIngredientId: null })
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        isNotNull(tasks.sourceIngredientId),
        inArray(tasks.sourceIngredientId, ingredientIds),
      ),
    );
}

/** True when ≥1 active task anchors the given recipe (for a manual-purge unlink decision). */
export async function countTasksUsingRecipe(
  db: TenantClient,
  organizationId: string,
  recipeId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        eq(tasks.sourceRecipeId, recipeId),
      ),
    );
  return rows[0]?.value ?? 0;
}

/** True when ≥1 task anchors the given ingredient (for a manual-purge unlink decision). */
export async function countTasksUsingIngredient(
  db: TenantClient,
  organizationId: string,
  ingredientId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        eq(tasks.sourceIngredientId, ingredientId),
      ),
    );
  return rows[0]?.value ?? 0;
}
