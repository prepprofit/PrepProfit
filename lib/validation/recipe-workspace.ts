import { z } from 'zod';

/**
 * Zod contract for the Recipes 2.0 workspace save (plan §10). Domain limits
 * are validated HERE, before the transaction opens — the facade re-checks
 * referential integrity (ids, cycles, tenancy) inside the lock. Financial
 * fields are deliberately NOT part of this draft: money keeps flowing through
 * the existing manager-only actions.
 */

export const WORKSPACE_MAX_SECTIONS = 50;
export const WORKSPACE_MAX_LINES = 500;
export const WORKSPACE_NOTE_MAX_LENGTH = 500;
export const WORKSPACE_TITLE_MAX_LENGTH = 120;
/** Matches recipe_ingredients.quantity numeric(10,2). */
const QUANTITY_MAX = 99_999_999.99;

const quantitySchema = z.number().finite().min(0).max(QUANTITY_MAX);
const positiveQuantitySchema = z.number().finite().positive().max(QUANTITY_MAX);
const noteSchema = z.string().trim().max(WORKSPACE_NOTE_MAX_LENGTH).nullish();
const refSchema = z.string().min(1).max(64);

export const workspaceHeaderSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  subtitle: z.string().trim().max(200).nullish(),
  yieldQuantity: z.number().finite().positive().max(QUANTITY_MAX).nullish(),
  yieldUnit: z.string().trim().max(40).nullish(),
});

export const workspaceSectionSchema = z
  .object({
    id: refSchema.optional(),
    tempId: refSchema.optional(),
    title: z.string().trim().min(1).max(WORKSPACE_TITLE_MAX_LENGTH),
  })
  .refine((s) => s.id !== undefined || s.tempId !== undefined, {
    message: 'section needs id or tempId',
  });

export const workspaceLineSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ingredient'),
    id: refSchema.optional(),
    ingredientId: refSchema,
    quantity: quantitySchema,
    note: noteSchema,
    sectionRef: refSchema.nullish(),
  }),
  z.object({
    kind: z.literal('component'),
    id: refSchema.optional(),
    componentRecipeId: refSchema,
    quantityGrams: positiveQuantitySchema,
    note: noteSchema,
    sectionRef: refSchema.nullish(),
  }),
]);

export const WORKSPACE_MAX_STEPS = 300;
export const WORKSPACE_STEP_MAX_LENGTH = 2000;

export const workspaceMethodSectionSchema = z
  .object({
    id: refSchema.optional(),
    tempId: refSchema.optional(),
    title: z.string().trim().min(1).max(WORKSPACE_TITLE_MAX_LENGTH),
  })
  .refine((s) => s.id !== undefined || s.tempId !== undefined, {
    message: 'method section needs id or tempId',
  });

export const workspaceStepSchema = z.object({
  id: refSchema.optional(),
  instruction: z.string().trim().min(1).max(WORKSPACE_STEP_MAX_LENGTH),
  sectionRef: refSchema.nullish(),
});

export const workspaceSaveSchema = z.object({
  recipeId: refSchema,
  expectedVersion: z.number().int().min(1),
  header: workspaceHeaderSchema.optional(),
  sections: z.array(workspaceSectionSchema).max(WORKSPACE_MAX_SECTIONS).optional(),
  lines: z.array(workspaceLineSchema).max(WORKSPACE_MAX_LINES).optional(),
  methodSections: z
    .array(workspaceMethodSectionSchema)
    .max(WORKSPACE_MAX_SECTIONS)
    .optional(),
  steps: z.array(workspaceStepSchema).max(WORKSPACE_MAX_STEPS).optional(),
});

export type WorkspaceSaveInput = z.infer<typeof workspaceSaveSchema>;
