import { z } from 'zod';
import { NUMERIC_12_2_MAX } from '@/lib/calculations/production';
import { expectedUpdatedAtSchema } from '@/lib/validation/sales';

/**
 * Server-side validation for inventory depth — storage areas, transfers, physical
 * counts (Sprint 12c). CLAUDE.md: Zod on all user input, on the server; the org id is
 * never in the payload (derived from Clerk). Quantities are canonical `numeric(12,2)`;
 * there is no money here (areas/transfers/counts carry no monetary fields).
 *
 * `expectedUpdatedAt` (optimistic concurrency) is reused from the sales schema — a
 * server-issued ISO timestamp the client echoes back.
 */

/** Area name: trimmed 1..80 (matches the DB CHECK). Export paths neutralize formulas. */
export const areaNameSchema = z.string().trim().min(1).max(80);

const noteSchema = z
  .string()
  .trim()
  .max(1000)
  .transform((s) => (s === '' ? null : s))
  .nullable()
  .optional();

export const createAreaSchema = z.object({
  name: areaNameSchema,
});

export const renameAreaSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  name: areaNameSchema,
});

export const deleteAreaSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

/**
 * Transfer one ingredient's stock from one area to another. `areaFromId`/`areaToId`
 * are concrete area ids (the UI writes the default area's id; `null` is accepted only
 * as the legacy/default alias and is resolved + re-compared in the data layer). The raw
 * refine here rejects an obvious self-transfer; the data layer rejects a null-vs-default
 * alias collision. `clientTransferId` is the deterministic F1 replay key.
 */
export const transferSchema = z
  .object({
    ingredientId: z.string().trim().min(1),
    areaFromId: z.string().trim().min(1).nullable(),
    areaToId: z.string().trim().min(1).nullable(),
    qty: z.number().positive().max(NUMERIC_12_2_MAX),
    clientTransferId: z.string().uuid(),
  })
  .superRefine((t, ctx) => {
    if (t.areaFromId !== null && t.areaFromId === t.areaToId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source and destination areas must differ.',
        path: ['areaToId'],
      });
    }
  });

/** Start a draft count for an area (storageAreaId null = default alias). */
export const createStockCountSchema = z.object({
  storageAreaId: z.string().trim().min(1).nullable(),
  note: noteSchema,
});

/** One counted line: an ingredient + its counted canonical amount (≥ 0). */
const stockCountItemSchema = z.object({
  ingredientId: z.string().trim().min(1),
  countedCanonical: z.number().min(0).max(NUMERIC_12_2_MAX),
});

/** Replace a draft count's line set (optimistic-locked on the count token). */
export const updateStockCountSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  note: noteSchema,
  items: z.array(stockCountItemSchema).max(2000),
});

/** Commit / delete a draft count carries only the optimistic-concurrency token. */
export const stockCountStateSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

export type CreateAreaInput = z.infer<typeof createAreaSchema>;
export type RenameAreaInput = z.infer<typeof renameAreaSchema>;
export type TransferInput = z.infer<typeof transferSchema>;
export type CreateStockCountInput = z.infer<typeof createStockCountSchema>;
export type UpdateStockCountInput = z.infer<typeof updateStockCountSchema>;
export type StockCountItemInput = z.infer<typeof stockCountItemSchema>;
