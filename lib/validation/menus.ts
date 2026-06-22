import { z } from 'zod';

/**
 * Server-side validation for menus / combos (Sprint 10). CLAUDE.md: Zod on all
 * user input, on the server. The org id is never part of the payload (derived from
 * Clerk). Manager-only at the action layer; selling price is integer cents.
 *
 * A saved menu always has 1..100 DISTINCT recipe lines (no draft/empty state); a
 * recipe may appear at most once (multiples are expressed via `quantity`). Duplicate
 * recipe ids are rejected here, BEFORE any data access.
 */

const menuItemSchema = z.object({
  recipeId: z.string().trim().min(1),
  // Portions of this recipe in the menu (integer 1..1000).
  quantity: z.number().int().min(1).max(1000),
});

export const menuSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    // Selling price per menu in integer cents; nullable/optional = "no price set".
    sellingPriceCents: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
    notes: z
      .string()
      .trim()
      .max(1000)
      .transform((s) => (s === '' ? null : s))
      .nullable()
      .optional(),
    items: z.array(menuItemSchema).min(1).max(100),
  })
  .refine(
    // One row per recipe — duplicates are a client bug, rejected before data access.
    (v) => new Set(v.items.map((i) => i.recipeId)).size === v.items.length,
    { message: 'A recipe may appear only once in a menu.', path: ['items'] },
  );

export type MenuFormInput = z.infer<typeof menuSchema>;
