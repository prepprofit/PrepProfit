import { z } from 'zod';
import { dateStringSchema } from '@/lib/validation/transactions';
import { MAX_TASKS_PER_LIST } from '@/lib/data/tasks';

/**
 * Server-side validation for kitchen task lists + tasks (Sprint 6). CLAUDE.md: Zod on
 * all user input, on the server. The org id is never part of the payload (derived from
 * Clerk). There is NO money field anywhere — task lists are operational only.
 *
 * `expectedUpdatedAt` (optimistic concurrency) is a server-issued ISO timestamp the
 * client echoes back; it is required on every non-create mutation. Free-text fields
 * trim and collapse "" → null so an empty box clears the value.
 */

const expectedUpdatedAtSchema = z.string().datetime();

const nameSchema = z.string().trim().min(1).max(200);

const titleSchema = z.string().trim().min(1).max(200);

const notesSchema = z
  .string()
  .trim()
  .max(1000)
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .optional();

const stationSchema = z
  .string()
  .trim()
  .max(60)
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .optional();

// A bare calendar date or null/absent. Real-date validation lives in dateStringSchema.
const optionalDate = dateStringSchema.nullable().optional();

// ── List schemas ───────────────────────────────────────────────────────────

export const createTaskListSchema = z.object({
  name: nameSchema,
  notes: notesSchema,
  scheduledFor: optionalDate,
});

export const updateTaskListSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  name: nameSchema,
  notes: notesSchema,
  scheduledFor: optionalDate,
});

/** reset / soft-delete carry only the optimistic-concurrency token. */
export const taskListStateSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

/** Rail reorder: a bounded list of distinct list ids in their new order. */
export const reorderTaskListsSchema = z.object({
  orderedIds: z.array(z.string().trim().min(1)).min(1).max(1000),
});

// ── Task schemas ───────────────────────────────────────────────────────────

export const addTaskSchema = z.object({
  title: titleSchema,
  notes: notesSchema,
  station: stationSchema,
  dueOn: optionalDate,
});

export const updateTaskSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  title: titleSchema,
  notes: notesSchema,
  station: stationSchema,
  dueOn: optionalDate,
});

export const toggleTaskSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  done: z.boolean(),
});

export const assignTaskSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  // A Clerk org-member id, or null to clear. Membership is validated in the action.
  assigneeUserId: z.string().trim().min(1).nullable(),
});

/** delete task carries only the optimistic-concurrency token. */
export const taskStateSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

/** Reorder tasks within one list (bounded by the per-list cap). */
export const reorderTasksSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  orderedTaskIds: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(MAX_TASKS_PER_LIST),
});

// ── Data-anchored task creation ──────────────────────────────────────────────

export const createReorderTaskSchema = z.object({
  listId: z.string().trim().min(1),
  ingredientId: z.string().trim().min(1),
});

export const createPrepTaskSchema = z.object({
  listId: z.string().trim().min(1),
  recipeId: z.string().trim().min(1),
});

export type CreateTaskListInput = z.infer<typeof createTaskListSchema>;
export type UpdateTaskListInput = z.infer<typeof updateTaskListSchema>;
export type AddTaskInput = z.infer<typeof addTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
