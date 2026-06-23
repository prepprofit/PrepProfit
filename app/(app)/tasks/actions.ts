'use server';

import { revalidatePath } from 'next/cache';
import { getOrgId, getUserId, isActiveOrgMember, isManager } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { unexpected } from '@/lib/observability';
import { auditActor, writeAuditEvent } from '@/lib/data/audit';
import {
  addTask,
  assignTask,
  createPrepTaskFromRecipe,
  createReorderTaskFromIngredient,
  createTaskList,
  deleteTask,
  duplicateTaskList,
  listTaskListOptions,
  reorderTaskLists,
  reorderTasks,
  resetTaskList,
  softDeleteTaskList,
  toggleTask,
  updateTask,
  updateTaskList,
  type TaskListOption,
} from '@/lib/data/tasks';
import {
  addTaskSchema,
  assignTaskSchema,
  createPrepTaskSchema,
  createReorderTaskSchema,
  createTaskListSchema,
  reorderTaskListsSchema,
  reorderTasksSchema,
  taskListStateSchema,
  taskStateSchema,
  toggleTaskSchema,
  updateTaskListSchema,
  updateTaskSchema,
} from '@/lib/validation/tasks';
import type { ActionResult } from '@/lib/action-result';

/**
 * Server Actions for kitchen task lists + tasks (Sprint 6). RBAC ASYMMETRY (L2 / D1):
 *  - MANAGER-ONLY: list create/update/delete/reset/duplicate/reorder, task assign,
 *    task hard-delete, and reorder-task-from-ingredient. `isManager()` is checked
 *    FIRST → kitchen gets `FORBIDDEN` before any data access.
 *  - BOTH ROLES: toggle complete, add/update/reorder tasks, prep-task-from-recipe —
 *    scoped to an ACTIVE list.
 * Trash restore/purge of lists live in app/(app)/trash/actions.ts (manager-only).
 *
 * RULE #1: org id from Clerk on the server, writes inside `withOrg` (RLS), Zod on all
 * input. Canonical order: RBAC → Zod → external membership validation when needed →
 * withOrg(mutation + audit in one tx) → targeted revalidate. A refused/stale/no-op
 * op does NOT audit. Audit metadata is ids/counts/status/sourceKind only — NEVER task
 * titles, notes, station, or assignee names (CLAUDE.md).
 */

function revalidateTasks(listId?: string): void {
  revalidatePath('/tasks');
  if (listId) revalidatePath(`/tasks/${listId}`);
}

/**
 * Active task lists as picker options, for the integration affordances (a prep task
 * from a recipe / a reorder task from an ingredient). Both roles — the data is
 * money-free. Returns [] (never throws to the client) when there are no lists.
 */
export async function taskListOptionsAction(): Promise<TaskListOption[]> {
  const organizationId = await getOrgId();
  return withOrg(organizationId, (tx) => listTaskListOptions(tx, organizationId));
}

// ── List actions (manager-only) ───────────────────────────────────────────────

export async function createTaskListAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = createTaskListSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const id = await withOrg(organizationId, async (tx) => {
    const list = await createTaskList(tx, organizationId, {
      name: parsed.data.name,
      notes: parsed.data.notes ?? null,
      scheduledFor: parsed.data.scheduledFor ?? null,
    });
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'taskList.create',
      entityType: 'taskList',
      entityId: list.id,
      metadata: { hasScheduledDate: list.scheduledFor !== null },
    });
    return list.id;
  });
  revalidateTasks(id);
  return { ok: true, data: { id } };
}

export async function updateTaskListAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = updateTaskListSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await updateTaskList(tx, organizationId, id, expectedUpdatedAt, {
      name: parsed.data.name,
      notes: parsed.data.notes ?? null,
      scheduledFor: parsed.data.scheduledFor ?? null,
    });
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'taskList.update',
      entityType: 'taskList',
      entityId: id,
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'TASK_LIST_STALE' };
  revalidateTasks(id);
  return { ok: true, data: undefined };
}

export async function deleteTaskListAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = taskListStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await softDeleteTaskList(tx, organizationId, id, expectedUpdatedAt);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'taskList.delete',
      entityType: 'taskList',
      entityId: id,
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'TASK_LIST_STALE' };
  revalidateTasks(id);
  revalidatePath('/trash');
  return { ok: true, data: undefined };
}

export async function resetTaskListAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = taskListStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await resetTaskList(tx, organizationId, id, expectedUpdatedAt);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'taskList.reset',
      entityType: 'taskList',
      entityId: id,
      metadata: { resetCount: result.resetCount },
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'TASK_LIST_STALE' };
  revalidateTasks(id);
  return { ok: true, data: undefined };
}

export async function duplicateTaskListAction(
  id: string,
  newName: string,
): Promise<ActionResult<{ id: string }>> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = createTaskListSchema.shape.name.safeParse(newName);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await duplicateTaskList(tx, organizationId, id, parsed.data);
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'taskList.duplicate',
      entityType: 'taskList',
      entityId: result.list.id,
      metadata: { sourceListId: id, taskCount: result.taskCount },
    });
    return { id: result.list.id };
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  revalidateTasks(outcome.id);
  return { ok: true, data: outcome };
}

export async function reorderTaskListsAction(
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = reorderTaskListsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  await withOrg(organizationId, async (tx) => {
    const reordered = await reorderTaskLists(tx, organizationId, parsed.data.orderedIds);
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'taskList.reorder',
      entityType: 'taskList',
      metadata: { count: reordered },
    });
  });
  revalidateTasks();
  return { ok: true, data: undefined };
}

// ── Task actions (both roles unless noted) ────────────────────────────────────

export async function addTaskAction(
  listId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = addTaskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await addTask(tx, organizationId, listId, {
      title: parsed.data.title,
      notes: parsed.data.notes ?? null,
      station: parsed.data.station ?? null,
      dueOn: parsed.data.dueOn ?? null,
    });
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'task.create',
      entityType: 'task',
      entityId: result.task.id,
      metadata: { listId, sourceKind: 'manual' },
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'not_editable') return { ok: false, code: 'TASK_LIST_NOT_EDITABLE' };
  if (outcome === 'full') return { ok: false, code: 'TASK_LIST_FULL' };
  revalidateTasks(listId);
  return { ok: true, data: undefined };
}

export async function updateTaskAction(
  taskId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = updateTaskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await updateTask(tx, organizationId, taskId, expectedUpdatedAt, {
      title: parsed.data.title,
      notes: parsed.data.notes ?? null,
      station: parsed.data.station ?? null,
      dueOn: parsed.data.dueOn ?? null,
    });
    if (result.status !== 'ok') return { status: result.status };
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'task.update',
      entityType: 'task',
      entityId: taskId,
      metadata: { listId: result.listId, sourceKind: result.task.sourceKind },
    });
    return { status: 'ok' as const, listId: result.listId };
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'stale') return { ok: false, code: 'TASK_STALE' };
  if (outcome.status === 'not_editable') {
    return { ok: false, code: 'TASK_LIST_NOT_EDITABLE' };
  }
  revalidateTasks(outcome.listId);
  return { ok: true, data: undefined };
}

export async function toggleTaskAction(
  taskId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = toggleTaskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const userId = await getUserId();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await toggleTask(
      tx,
      organizationId,
      taskId,
      expectedUpdatedAt,
      parsed.data.done,
      userId,
    );
    if (result.status !== 'ok') return { status: result.status };
    // Idempotent no-op toggles write nothing and are NOT audited.
    if (result.changed) {
      await writeAuditEvent(tx, organizationId, actor, {
        action: parsed.data.done ? 'task.complete' : 'task.reopen',
        entityType: 'task',
        entityId: taskId,
        metadata: { listId: result.listId },
      });
    }
    return { status: 'ok' as const, listId: result.listId };
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'stale') return { ok: false, code: 'TASK_STALE' };
  if (outcome.status === 'not_editable') {
    return { ok: false, code: 'TASK_LIST_NOT_EDITABLE' };
  }
  revalidateTasks(outcome.listId);
  return { ok: true, data: undefined };
}

/** Set/clear a task's assignee (manager-only, D2). Validates org membership first. */
export async function assignTaskAction(
  taskId: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = assignTaskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const assigneeUserId = parsed.data.assigneeUserId;

  // Validate the assignee is an active org member BEFORE any data mutation. A
  // transient Clerk failure throws → mapped to UNEXPECTED (never silently accepted).
  if (assigneeUserId !== null) {
    try {
      if (!(await isActiveOrgMember(assigneeUserId))) {
        return { ok: false, code: 'TASK_ASSIGNEE_INVALID' };
      }
    } catch (err) {
      return unexpected('assignTaskAction', err, organizationId);
    }
  }

  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await assignTask(
      tx,
      organizationId,
      taskId,
      expectedUpdatedAt,
      assigneeUserId,
    );
    if (result.status !== 'ok') return { status: result.status };
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'task.assign',
      entityType: 'task',
      entityId: taskId,
      // No name — assigned is a boolean descriptor, the id is an id (no PII).
      metadata: { listId: result.listId, assigned: assigneeUserId !== null },
    });
    return { status: 'ok' as const, listId: result.listId };
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'stale') return { ok: false, code: 'TASK_STALE' };
  if (outcome.status === 'not_editable') {
    return { ok: false, code: 'TASK_LIST_NOT_EDITABLE' };
  }
  revalidateTasks(outcome.listId);
  return { ok: true, data: undefined };
}

export async function reorderTasksAction(
  listId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = reorderTasksSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await reorderTasks(
      tx,
      organizationId,
      listId,
      expectedUpdatedAt,
      parsed.data.orderedTaskIds,
    );
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'taskList.reorder',
      entityType: 'taskList',
      entityId: listId,
      metadata: { count: parsed.data.orderedTaskIds.length },
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome === 'stale') return { ok: false, code: 'TASK_LIST_STALE' };
  if (outcome === 'not_editable') return { ok: false, code: 'TASK_LIST_NOT_EDITABLE' };
  revalidateTasks(listId);
  return { ok: true, data: undefined };
}

/** Hard-delete a single task row from an active list (manager-only, D8). */
export async function deleteTaskAction(
  taskId: string,
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = taskStateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await deleteTask(tx, organizationId, taskId, expectedUpdatedAt);
    if (result.status !== 'ok') return { status: result.status };
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'task.delete',
      entityType: 'task',
      entityId: taskId,
      metadata: { listId: result.listId },
    });
    return { status: 'ok' as const, listId: result.listId };
  });

  if (outcome.status === 'not_found') return { ok: false, code: 'NOT_FOUND' };
  if (outcome.status === 'stale') return { ok: false, code: 'TASK_STALE' };
  if (outcome.status === 'not_editable') {
    return { ok: false, code: 'TASK_LIST_NOT_EDITABLE' };
  }
  revalidateTasks(outcome.listId);
  return { ok: true, data: undefined };
}

// ── Data-anchored task creation (D7) ──────────────────────────────────────────

/** Create a reorder task from a low-stock ingredient (manager-only, D7). */
export async function createReorderTaskFromIngredientAction(
  input: unknown,
): Promise<ActionResult> {
  if (!(await isManager())) return { ok: false, code: 'FORBIDDEN' };
  const parsed = createReorderTaskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const { listId, ingredientId } = parsed.data;

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await createReorderTaskFromIngredient(
      tx,
      organizationId,
      listId,
      ingredientId,
    );
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'task.create',
      entityType: 'task',
      entityId: result.task.id,
      metadata: { listId, sourceKind: 'reorder' },
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found' || outcome === 'source_invalid') {
    return { ok: false, code: 'NOT_FOUND' };
  }
  if (outcome === 'not_editable') return { ok: false, code: 'TASK_LIST_NOT_EDITABLE' };
  if (outcome === 'full') return { ok: false, code: 'TASK_LIST_FULL' };
  revalidateTasks(listId);
  return { ok: true, data: undefined };
}

/** Create a prep task from a recipe (both roles, D7). */
export async function createPrepTaskFromRecipeAction(
  input: unknown,
): Promise<ActionResult> {
  const parsed = createPrepTaskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };

  const organizationId = await getOrgId();
  const actor = await auditActor();
  const { listId, recipeId } = parsed.data;

  const outcome = await withOrg(organizationId, async (tx) => {
    const result = await createPrepTaskFromRecipe(
      tx,
      organizationId,
      listId,
      recipeId,
    );
    if (result.status !== 'ok') return result.status;
    await writeAuditEvent(tx, organizationId, actor, {
      action: 'task.create',
      entityType: 'task',
      entityId: result.task.id,
      metadata: { listId, sourceKind: 'prep' },
    });
    return 'ok' as const;
  });

  if (outcome === 'not_found' || outcome === 'source_invalid') {
    return { ok: false, code: 'NOT_FOUND' };
  }
  if (outcome === 'not_editable') return { ok: false, code: 'TASK_LIST_NOT_EDITABLE' };
  if (outcome === 'full') return { ok: false, code: 'TASK_LIST_FULL' };
  revalidateTasks(listId);
  return { ok: true, data: undefined };
}
