import { z } from 'zod';
import { MAX_TASKS_PER_LIST } from '@/lib/data/tasks';

/**
 * Server-side validation for the Prep/Reorder Planner (Sprint 7). CLAUDE.md: Zod on all
 * user input, on the server. The org id is never part of the payload (derived from Clerk).
 * There is NO money field anywhere — the planner is operational/money-free.
 */

/** A positive whole quantity of portions/covers, bounded to a sane kitchen scale. */
const positiveCount = z.number().int().positive().max(1_000_000);

const idSchema = z.string().trim().min(1);

/** How many distinct selection lines a single plan may carry. */
const MAX_SELECTION_LINES = 200;

/**
 * The demand a user assembles: explicit per-recipe portions and/or menu × covers. Both
 * arrays may be empty (an empty plan is valid — it just yields nothing to act on).
 */
export const buildPrepPlanSchema = z.object({
  recipes: z
    .array(z.object({ recipeId: idSchema, portions: positiveCount }))
    .max(MAX_SELECTION_LINES)
    .default([]),
  menus: z
    .array(z.object({ menuId: idSchema, covers: positiveCount }))
    .max(MAX_SELECTION_LINES)
    .default([]),
});
export type BuildPrepPlanInput = z.infer<typeof buildPrepPlanSchema>;

/**
 * Turn a reviewed plan into anchored tasks in a target list. Bounded by the per-list cap so
 * a scripted payload can't ask for an unbounded batch (the data layer also enforces it).
 */
export const createPrepPlanTasksSchema = z.object({
  listId: idSchema,
  prepRecipeIds: z.array(idSchema).max(MAX_TASKS_PER_LIST).default([]),
  reorderIngredientIds: z.array(idSchema).max(MAX_TASKS_PER_LIST).default([]),
});
export type CreatePrepPlanTasksInput = z.infer<typeof createPrepPlanTasksSchema>;
