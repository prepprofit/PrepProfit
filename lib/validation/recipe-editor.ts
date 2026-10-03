import { z } from 'zod';
import {
  WORKSPACE_MAX_LINES,
  WORKSPACE_MAX_SECTIONS,
  WORKSPACE_MAX_STEPS,
  workspaceLineSchema,
  workspaceMethodSectionSchema,
  workspaceSectionSchema,
  workspaceStepSchema,
} from '@/lib/validation/recipe-workspace';
import { MAX_RECIPE_PRESETS } from '@/lib/validation/recipe-presets';

/**
 * Zod contract for the recipe editor (create + edit). ONE payload carries
 * everything the chef sees on the form — name, folder, display unit, ingredient
 * lines, preparation method / notes, finished weight and kitchen presets — so it
 * saves atomically or not at all. No money field exists here: the editor is
 * operational for both roles, and Zod strips anything else the client sends.
 */

/**
 * Max length of the "Preparation method / notes" text typed or pasted in the
 * editor. Wider than the photo-import bound (`RECIPE_NOTES_MAX_LENGTH`), so an
 * imported note can always be re-saved here, and a full pasted method fits.
 */
export const RECIPE_METHOD_MAX_LENGTH = 10_000;

const refSchema = z.string().min(1).max(64);

/** Matches recipes.yield_weight_grams / recipe_presets.target_weight_grams numeric(10,2). */
const gramsSchema = z.number().finite().positive().max(99_999_999.99);

export const editorPresetSchema = z.object({
  id: refSchema.optional(),
  name: z.string().trim().min(1).max(80),
  targetWeightGrams: gramsSchema,
});

const editorFieldsSchema = z.object({
  name: z.string().trim().min(1).max(160),
  folderId: refSchema.nullable(),
  displayUnit: z.enum(['g', 'kg']),
  notes: z
    .string()
    .trim()
    .max(RECIPE_METHOD_MAX_LENGTH)
    .transform((s) => (s === '' ? null : s)),
  /** Finished weight: yield % after loss, or a weighed batch (wins when present). */
  yield: z.object({
    percentage: z.number().int().min(1).max(100),
    measuredGrams: gramsSchema.nullable(),
  }),
  lines: z.array(workspaceLineSchema).max(WORKSPACE_MAX_LINES),
  presets: z
    .array(editorPresetSchema)
    .max(MAX_RECIPE_PRESETS)
    .refine((list) => new Set(list.map((p) => p.name.toLowerCase())).size === list.length, {
      message: 'Preset names must be unique.',
    })
    .refine((list) => {
      const ids = list.flatMap((p) => (p.id ? [p.id] : []));
      return new Set(ids).size === ids.length;
    }),
});

/** A new recipe: nothing exists yet, so lines carry no ids and there are no sections or steps. */
export const recipeEditorCreateSchema = editorFieldsSchema;

/**
 * Saving an existing recipe: optimistic concurrency on `expectedVersion`. Ingredient
 * sections and structured method steps already stored are sent back (edited or
 * untouched) so nothing the recipe had is dropped.
 */
export const recipeEditorUpdateSchema = editorFieldsSchema.extend({
  recipeId: refSchema,
  expectedVersion: z.number().int().min(1),
  sections: z.array(workspaceSectionSchema).max(WORKSPACE_MAX_SECTIONS),
  methodSections: z.array(workspaceMethodSectionSchema).max(WORKSPACE_MAX_SECTIONS),
  steps: z.array(workspaceStepSchema).max(WORKSPACE_MAX_STEPS),
  coverMediaId: refSchema.nullable(),
});

export type RecipeEditorCreateInput = z.input<typeof recipeEditorCreateSchema>;
export type RecipeEditorUpdateInput = z.input<typeof recipeEditorUpdateSchema>;
