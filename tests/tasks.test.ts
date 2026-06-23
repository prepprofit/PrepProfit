import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import type { TenantDb } from '@/lib/db/tenant';
import { runInOrg } from '@/lib/db/tenant';
import {
  taskLists as taskListsTable,
  tasks as tasksTable,
  ingredients as ingredientsTable,
  recipes as recipesTable,
} from '@/lib/db/schema';
import type { TaskList } from '@/lib/db/schema';
import { createIngredient } from '@/lib/data/ingredients';
import { createRecipe, softDeleteRecipe } from '@/lib/data/recipes';
import { softDeleteIngredient } from '@/lib/data/ingredients';
import {
  addTask,
  createPrepTaskFromRecipe,
  createReorderTaskFromIngredient,
  createTaskList,
  deleteTask,
  duplicateTaskList,
  getTaskListWithTasks,
  listTaskLists,
  listTrashedTaskLists,
  reorderTasks,
  resetTaskList,
  restoreTaskList,
  purgeTaskList,
  softDeleteTaskList,
  toggleTask,
  updateTask,
  updateTaskList,
} from '@/lib/data/tasks';
import { createProduction } from '@/lib/data/productions';
import { purgeRecipeWithGuards } from '@/lib/data/recipe-purge';
import { purgeExpired } from '@/lib/data/trash';
import { buildOrgDataExport } from '@/lib/data/account-export';
import { purgeCutoff, TRASH_RETENTION_DAYS } from '@/lib/trash';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const ACTOR = 'user_actor';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);
const tick = () => new Promise((r) => setTimeout(r, 5));

async function getList(db: TenantDb, org: string, id: string): Promise<TaskList> {
  const [row] = await db
    .select()
    .from(taskListsTable)
    .where(eq(taskListsTable.id, id));
  void org;
  return row!;
}

async function getTask(db: TenantDb, id: string) {
  const [row] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
  return row!;
}

describe('tasks data layer (Sprint 6)', () => {
  let client: PGlite;
  let db: TenantDb;

  beforeEach(async () => {
    const test = await createTestDb();
    client = test.client;
    db = test.db;
  });

  afterEach(async () => {
    await client.close();
  });

  it('creates a list + tasks and rolls up progress (money-free)', async () => {
    const list = await createTaskList(db, ORG_A, {
      name: 'Opening',
      notes: null,
      scheduledFor: null,
    });
    await addTask(db, ORG_A, list.id, {
      title: 'Prep mise',
      notes: null,
      station: 'grill',
      dueOn: null,
    });
    await addTask(db, ORG_A, list.id, {
      title: 'Wipe line',
      notes: null,
      station: null,
      dueOn: null,
    });

    const detail = await getTaskListWithTasks(db, ORG_A, list.id);
    expect(detail?.tasks).toHaveLength(2);
    expect(detail?.progress).toEqual({ done: 0, total: 2, allDone: false });
  });

  it('toggle stamps completed_at/by on done and clears on reopen', async () => {
    const list = await createTaskList(db, ORG_A, {
      name: 'L',
      notes: null,
      scheduledFor: null,
    });
    const added = await addTask(db, ORG_A, list.id, {
      title: 'T',
      notes: null,
      station: null,
      dueOn: null,
    });
    if (added.status !== 'ok') throw new Error('add failed');

    const done = await toggleTask(db, ORG_A, added.task.id, added.task.updatedAt, true, ACTOR);
    expect(done.status).toBe('ok');
    const stamped = await getTask(db, added.task.id);
    expect(stamped.status).toBe('done');
    expect(stamped.completedAt).not.toBeNull();
    expect(stamped.completedBy).toBe(ACTOR);

    const reopened = await toggleTask(db, ORG_A, stamped.id, stamped.updatedAt, false, ACTOR);
    expect(reopened.status).toBe('ok');
    const cleared = await getTask(db, added.task.id);
    expect(cleared.status).toBe('open');
    expect(cleared.completedAt).toBeNull();
    expect(cleared.completedBy).toBeNull();
  });

  it('toggle is idempotent: re-completing writes nothing new', async () => {
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });
    const added = await addTask(db, ORG_A, list.id, { title: 'T', notes: null, station: null, dueOn: null });
    if (added.status !== 'ok') throw new Error('add failed');

    const first = await toggleTask(db, ORG_A, added.task.id, added.task.updatedAt, true, ACTOR);
    if (first.status !== 'ok') throw new Error('toggle failed');
    expect(first.changed).toBe(true);
    const stampedAt = (await getTask(db, added.task.id)).completedAt;

    const again = await toggleTask(db, ORG_A, first.task.id, first.task.updatedAt, true, ACTOR);
    expect(again.status).toBe('ok');
    if (again.status === 'ok') expect(again.changed).toBe(false);
    expect((await getTask(db, added.task.id)).completedAt).toEqual(stampedAt);
  });

  it('DB CHECK rejects a done task with null completion, empty title and bad source combo', async () => {
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });

    await expect(
      db.insert(tasksTable).values({
        organizationId: ORG_A,
        taskListId: list.id,
        title: 'done but unstamped',
        status: 'done',
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(tasksTable).values({
        organizationId: ORG_A,
        taskListId: list.id,
        title: '   ',
      }),
    ).rejects.toThrow();

    // prep kind without a recipe link violates the source-shape CHECK.
    await expect(
      db.insert(tasksTable).values({
        organizationId: ORG_A,
        taskListId: list.id,
        title: 'x',
        sourceKind: 'prep',
      }),
    ).rejects.toThrow();
  });

  it('reorder preserves order; reset reopens + clears; child mutation bumps the list token', async () => {
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });
    const a = await addTask(db, ORG_A, list.id, { title: 'A', notes: null, station: null, dueOn: null });
    const b = await addTask(db, ORG_A, list.id, { title: 'B', notes: null, station: null, dueOn: null });
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('add failed');

    const listAfterAdd = await getList(db, ORG_A, list.id);

    // Reorder B before A.
    await tick();
    const reorder = await reorderTasks(db, ORG_A, list.id, listAfterAdd.updatedAt, [
      b.task.id,
      a.task.id,
    ]);
    expect(reorder.status).toBe('ok');
    const detail = await getTaskListWithTasks(db, ORG_A, list.id);
    expect(detail?.tasks.map((t) => t.title)).toEqual(['B', 'A']);

    // The child mutation bumped the parent token.
    const bumped = await getList(db, ORG_A, list.id);
    expect(bumped.updatedAt.getTime()).toBeGreaterThan(listAfterAdd.updatedAt.getTime());

    // Complete both, then reset.
    for (const id of [a.task.id, b.task.id]) {
      const cur = await getTask(db, id);
      await toggleTask(db, ORG_A, id, cur.updatedAt, true, ACTOR);
    }
    const beforeReset = await getList(db, ORG_A, list.id);
    const reset = await resetTaskList(db, ORG_A, list.id, beforeReset.updatedAt);
    expect(reset.status).toBe('ok');
    const afterReset = await getTaskListWithTasks(db, ORG_A, list.id);
    expect(afterReset?.tasks.every((t) => t.status === 'open')).toBe(true);
    expect(afterReset?.tasks.every((t) => t.completedAt === null)).toBe(true);
  });

  it('duplicate copies the header + tasks as open/unassigned with links preserved', async () => {
    const ing = await createIngredient(db, ORG_A, { name: 'Flour', dimension: 'weight', priceCents: 100 });
    const list = await createTaskList(db, ORG_A, { name: 'Daily', notes: 'n', scheduledFor: '2026-06-23' });
    const reorder = await createReorderTaskFromIngredient(db, ORG_A, list.id, ing.id);
    if (reorder.status !== 'ok') throw new Error('reorder task failed');
    // Mark it done + assigned in the source.
    const cur = await getTask(db, reorder.task.id);
    await toggleTask(db, ORG_A, reorder.task.id, cur.updatedAt, true, ACTOR);
    await db.update(tasksTable).set({ assigneeUserId: 'u1' }).where(eq(tasksTable.id, reorder.task.id));

    const dup = await duplicateTaskList(db, ORG_A, list.id, 'Daily (copy)');
    expect(dup.status).toBe('ok');
    if (dup.status !== 'ok') return;
    const copy = await getTaskListWithTasks(db, ORG_A, dup.list.id);
    expect(copy?.name).toBe('Daily (copy)');
    expect(copy?.tasks).toHaveLength(1);
    const copied = copy!.tasks[0]!;
    expect(copied.status).toBe('open');
    expect(copied.assigneeUserId).toBeNull();
    expect(copied.sourceKind).toBe('reorder');
    expect(copied.sourceIngredientId).toBe(ing.id);
  });

  it('manager delete removes a task from an active list; a trashed parent refuses edits', async () => {
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });
    const added = await addTask(db, ORG_A, list.id, { title: 'T', notes: null, station: null, dueOn: null });
    if (added.status !== 'ok') throw new Error('add failed');

    const del = await deleteTask(db, ORG_A, added.task.id, added.task.updatedAt);
    expect(del.status).toBe('ok');
    expect(await getTaskListWithTasks(db, ORG_A, list.id).then((d) => d?.tasks.length)).toBe(0);

    // Add another, trash the list, then a task edit must be refused.
    const t2 = await addTask(db, ORG_A, list.id, { title: 'T2', notes: null, station: null, dueOn: null });
    if (t2.status !== 'ok') throw new Error('add failed');
    const listRow = await getList(db, ORG_A, list.id);
    await softDeleteTaskList(db, ORG_A, list.id, listRow.updatedAt);

    const edit = await updateTask(db, ORG_A, t2.task.id, t2.task.updatedAt, {
      title: 'nope',
      notes: null,
      station: null,
      dueOn: null,
    });
    expect(edit.status).toBe('not_editable');
  });

  it('stale list token is rejected with zero writes', async () => {
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });
    const stale = new Date(list.updatedAt.getTime() - 60_000);
    const result = await updateTaskList(db, ORG_A, list.id, stale, {
      name: 'changed',
      notes: null,
      scheduledFor: null,
    });
    expect(result.status).toBe('stale');
    expect((await getList(db, ORG_A, list.id)).name).toBe('L');
  });

  it('prep/reorder source links are set; a recipe purge nulls the link first (manual + cron)', async () => {
    const recipe = await createRecipe(db, ORG_A, { name: 'Sauce' });
    const ing = await createIngredient(db, ORG_A, { name: 'Salt', dimension: 'weight', priceCents: 50 });
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });

    const prep = await createPrepTaskFromRecipe(db, ORG_A, list.id, recipe.id);
    const reorder = await createReorderTaskFromIngredient(db, ORG_A, list.id, ing.id);
    if (prep.status !== 'ok' || reorder.status !== 'ok') throw new Error('source task failed');
    expect(prep.task.sourceKind).toBe('prep');
    expect(prep.task.sourceRecipeId).toBe(recipe.id);
    expect(reorder.task.sourceIngredientId).toBe(ing.id);

    // Manual recipe purge: trash then purge → the task link is nulled first, task survives.
    await softDeleteRecipe(db, ORG_A, recipe.id);
    const purge = await purgeRecipeWithGuards(db, ORG_A, recipe.id);
    expect(purge).toBe('ok');
    const afterRecipe = await getTask(db, prep.task.id);
    expect(afterRecipe.sourceKind).toBe('manual');
    expect(afterRecipe.sourceRecipeId).toBeNull();
    expect(afterRecipe.title).toBe('Sauce'); // survives as plain text

    // Cron purge of an expired ingredient nulls the reorder link first.
    await softDeleteIngredient(db, ORG_A, ing.id);
    await db
      .update(ingredientsTable)
      .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 1) })
      .where(eq(ingredientsTable.id, ing.id));
    await purgeExpired(db, ORG_A, purgeCutoff());
    const afterIng = await getTask(db, reorder.task.id);
    expect(afterIng.sourceKind).toBe('manual');
    expect(afterIng.sourceIngredientId).toBeNull();
  });

  it('a blocked recipe purge does NOT null the task source link', async () => {
    const recipe = await createRecipe(db, ORG_A, { name: 'Stock' });
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });
    const prep = await createPrepTaskFromRecipe(db, ORG_A, list.id, recipe.id);
    if (prep.status !== 'ok') throw new Error('prep failed');

    // Pin the recipe in a production so the purge is blocked.
    await createProduction(db, ORG_A, { reference: null, notes: null, plannedFor: null }, [
      { recipeId: recipe.id, plannedQty: 1 },
    ]);
    await softDeleteRecipe(db, ORG_A, recipe.id);
    const purge = await purgeRecipeWithGuards(db, ORG_A, recipe.id);
    expect(purge).toBe('in_production');

    const still = await getTask(db, prep.task.id);
    expect(still.sourceKind).toBe('prep');
    expect(still.sourceRecipeId).toBe(recipe.id);
  });

  it('the restrict FK blocks a raw recipe delete while a prep task references it', async () => {
    const recipe = await createRecipe(db, ORG_A, { name: 'Glaze' });
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });
    await createPrepTaskFromRecipe(db, ORG_A, list.id, recipe.id);
    await expect(
      db.delete(recipesTable).where(eq(recipesTable.id, recipe.id)),
    ).rejects.toThrow();
  });

  it('soft-delete → trash → restore/purge; an expired list auto-purges with its tasks', async () => {
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });
    await addTask(db, ORG_A, list.id, { title: 'T', notes: null, station: null, dueOn: null });

    const row = await getList(db, ORG_A, list.id);
    await softDeleteTaskList(db, ORG_A, list.id, row.updatedAt);
    expect(await listTaskLists(db, ORG_A)).toHaveLength(0);
    expect(await listTrashedTaskLists(db, ORG_A)).toHaveLength(1);

    const restored = await restoreTaskList(db, ORG_A, list.id);
    expect(restored).not.toBeNull();
    expect(await listTaskLists(db, ORG_A)).toHaveLength(1);

    // Trash again, age it past retention, purge: list + tasks gone.
    const row2 = await getList(db, ORG_A, list.id);
    await softDeleteTaskList(db, ORG_A, list.id, row2.updatedAt);
    await db
      .update(taskListsTable)
      .set({ deletedAt: daysAgo(TRASH_RETENTION_DAYS + 1) })
      .where(eq(taskListsTable.id, list.id));
    const result = await purgeExpired(db, ORG_A, purgeCutoff());
    expect(result.taskLists).toBe(1);
    expect(await db.select().from(tasksTable).where(eq(tasksTable.taskListId, list.id))).toHaveLength(0);
  });

  it('manual purge of a trashed list cascades its tasks', async () => {
    const list = await createTaskList(db, ORG_A, { name: 'L', notes: null, scheduledFor: null });
    await addTask(db, ORG_A, list.id, { title: 'T', notes: null, station: null, dueOn: null });
    const row = await getList(db, ORG_A, list.id);
    await softDeleteTaskList(db, ORG_A, list.id, row.updatedAt);
    await purgeTaskList(db, ORG_A, list.id);
    expect(await db.select().from(taskListsTable).where(eq(taskListsTable.id, list.id))).toHaveLength(0);
    expect(await db.select().from(tasksTable).where(eq(tasksTable.taskListId, list.id))).toHaveLength(0);
  });

  it('lists are org-isolated and present in the v12 export', async () => {
    const list = await createTaskList(db, ORG_A, { name: 'Only A', notes: null, scheduledFor: null });
    await addTask(db, ORG_A, list.id, { title: 'T', notes: null, station: null, dueOn: null });

    // Org B (RLS) sees none of A's lists.
    const seenByB = await runInOrg(db, ORG_B, (tx) => listTaskLists(tx, ORG_B));
    expect(seenByB).toHaveLength(0);

    const bundle = await runInOrg(db, ORG_A, (tx) => buildOrgDataExport(tx, ORG_A));
    expect(bundle.schemaVersion).toBe(13);
    expect((bundle.data.taskLists as unknown[]).length).toBe(1);
    expect((bundle.data.tasks as unknown[]).length).toBe(1);
  });
});
