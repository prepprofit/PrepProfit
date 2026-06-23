import { z } from 'zod';
import { dateStringSchema } from '@/lib/validation/transactions';
import { saleTotals } from '@/lib/calculations/tax';
import { NUMERIC_12_2_MAX } from '@/lib/calculations/production';

/**
 * Server-side validation for daily-close Sales (Sprint 12a). CLAUDE.md: Zod on all
 * user input, on the server. The org id is never part of the payload (derived from
 * Clerk). Money is integer cents; `taxRateBps` is integer basis points (0..10000),
 * defaulted client-side from the org rate (the post path additionally REQUIRES a
 * configured org rate — D5). The frozen sale/line totals, the income transaction and
 * the stock movements all derive on the server and can never be supplied.
 *
 * `expectedUpdatedAt` (optimistic concurrency) is required on every non-create
 * mutation and must be a server-issued ISO timestamp.
 */

/** Postgres `integer` (int4) ceiling — the money columns are integer cents. */
const INT4_MAX = 2_147_483_647;

const noteSchema = z
  .string()
  .trim()
  .max(1000)
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .optional();

/** A server-issued ISO timestamp the client echoes back as the optimistic-lock token. */
export const expectedUpdatedAtSchema = z.string().datetime();

/**
 * One sale line. The shape is validated by `itemKind`: exactly the matching ref is
 * set, and `ingredientQtyCanonical` is present + positive ONLY for an ingredient line
 * (mirroring the DB CHECK). The output is normalized so the unset refs are explicit
 * `null` for the data layer.
 */
const saleLineSchema = z
  .object({
    itemKind: z.enum(['recipe', 'menu', 'ingredient']),
    itemRecipeId: z.string().trim().min(1).nullable().optional(),
    itemMenuId: z.string().trim().min(1).nullable().optional(),
    itemIngredientId: z.string().trim().min(1).nullable().optional(),
    // Units sold (1..100000).
    quantity: z.number().int().min(1).max(100000),
    // Canonical stock consumed per sold unit — ingredient lines only.
    ingredientQtyCanonical: z
      .number()
      .positive()
      .max(NUMERIC_12_2_MAX)
      .nullable()
      .optional(),
    // Net price per sold unit in integer cents (0 allowed).
    unitNetCents: z.number().int().min(0).max(1_000_000_000),
    // Per-line tax rate in basis points (0..10000).
    taxRateBps: z.number().int().min(0).max(10000),
  })
  .superRefine((line, ctx) => {
    const refs = {
      recipe: line.itemRecipeId ?? null,
      menu: line.itemMenuId ?? null,
      ingredient: line.itemIngredientId ?? null,
    };
    // Exactly the ref implied by itemKind is set; the other two are null.
    for (const [kind, value] of Object.entries(refs)) {
      const shouldBeSet = kind === line.itemKind;
      if (shouldBeSet && value === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Missing ${kind} reference.`, path: [`item${cap(kind)}Id`] });
      }
      if (!shouldBeSet && value !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unexpected ${kind} reference.`, path: [`item${cap(kind)}Id`] });
      }
    }
    // ingredient_qty_canonical present+positive iff ingredient line.
    const hasQty = line.ingredientQtyCanonical != null;
    if (line.itemKind === 'ingredient' && !hasQty) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An ingredient line needs a per-unit stock quantity.',
        path: ['ingredientQtyCanonical'],
      });
    }
    if (line.itemKind !== 'ingredient' && hasQty) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only ingredient lines carry a per-unit stock quantity.',
        path: ['ingredientQtyCanonical'],
      });
    }
  })
  .transform((line) => ({
    itemKind: line.itemKind,
    itemRecipeId: line.itemKind === 'recipe' ? line.itemRecipeId! : null,
    itemMenuId: line.itemKind === 'menu' ? line.itemMenuId! : null,
    itemIngredientId: line.itemKind === 'ingredient' ? line.itemIngredientId! : null,
    quantity: line.quantity,
    ingredientQtyCanonical:
      line.itemKind === 'ingredient' ? line.ingredientQtyCanonical! : null,
    unitNetCents: line.unitNetCents,
    taxRateBps: line.taxRateBps,
  }));

const linesSchema = z.array(saleLineSchema).min(1).max(200);

/** Reject a sale whose summed net/tax/gross would overflow the int4 money columns. */
function checkSaleTotals(
  lines: z.infer<typeof linesSchema>,
  ctx: z.RefinementCtx,
): void {
  const totals = saleTotals(
    lines.map((l) => ({ netCents: l.quantity * l.unitNetCents, bps: l.taxRateBps })),
  );
  if (
    totals.netCents > INT4_MAX ||
    totals.taxCents > INT4_MAX ||
    totals.grossCents > INT4_MAX
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Sale total exceeds the maximum supported amount.',
      path: ['lines'],
    });
  }
}

export const createSaleSchema = z
  .object({
    saleDate: dateStringSchema,
    note: noteSchema,
    lines: linesSchema,
  })
  .superRefine((sale, ctx) => checkSaleTotals(sale.lines, ctx));

export const updateSaleSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    saleDate: dateStringSchema,
    note: noteSchema,
    lines: linesSchema,
  })
  .superRefine((sale, ctx) => checkSaleTotals(sale.lines, ctx));

/** post / void / delete carry only the optimistic-concurrency token. */
export const saleStateSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type UpdateSaleInput = z.infer<typeof updateSaleSchema>;
export type SaleStateInput = z.infer<typeof saleStateSchema>;
