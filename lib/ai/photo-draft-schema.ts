import { z } from 'zod';
import {
  PHOTO_DRAFT_ISSUE_CODES,
  PHOTO_DRAFT_LINE_STATUSES,
  type PhotoDraftLine,
} from './types';

/**
 * Strict validation of the CLIENT-EDITED photo draft sent to the stage endpoint
 * (improvement plan §4.2 / G2). The edited draft is untrusted input: the server
 * validates shape + length bounds here, then RE-DERIVES each line's status and
 * canonical values itself (it never trusts the client's `status`/`issues` or any
 * computed quantity). Bounds mirror the extraction schema so a forged draft can
 * neither balloon memory nor smuggle oversized fields past the planner.
 */

const MAX_LINES = 200;
const MAX_NAME_LEN = 200;
const MAX_UNIT_LEN = 40;
const MAX_RAWTEXT_LEN = 300;
const MAX_SECTION_LEN = 80;
const MAX_QTY_TEXT_LEN = 40;
const MAX_ID_LEN = 100;
const MAX_NOTES_LEN = 5000;
const MAX_PORTIONS = 100_000;

/**
 * One edited draft line. `ingredientName` may be blank here (the user cleared it) —
 * the server's re-derivation flags it and blocks staging, rather than the schema
 * rejecting the whole request. `status`/`issues` are accepted for shape but ignored
 * server-side; only `ignored` is honored (the user removed the line).
 */
const draftLineSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LEN),
  rawText: z.string().max(MAX_RAWTEXT_LEN).nullable(),
  section: z.string().max(MAX_SECTION_LEN).nullable(),
  ingredientName: z.string().max(MAX_NAME_LEN),
  quantityText: z.string().max(MAX_QTY_TEXT_LEN).nullable(),
  quantityValue: z.number().positive().finite().nullable(),
  unitToken: z.string().max(MAX_UNIT_LEN).nullable(),
  packageSizeValue: z.number().positive().finite().nullable(),
  packageSizeUnitToken: z.string().max(MAX_UNIT_LEN).nullable(),
  confidence: z.number().min(0).max(1),
  status: z.enum(PHOTO_DRAFT_LINE_STATUSES),
  issues: z.array(z.object({ code: z.enum(PHOTO_DRAFT_ISSUE_CODES) })).max(10),
}) satisfies z.ZodType<PhotoDraftLine>;

export const stagePhotoDraftSchema = z.object({
  attemptId: z.string().min(1).max(MAX_ID_LEN),
  recipe: z.object({
    name: z.string().trim().min(1).max(MAX_NAME_LEN),
    yieldPortions: z.number().int().positive().max(MAX_PORTIONS).nullable(),
    preparationNotes: z.string().max(MAX_NOTES_LEN).nullable(),
    lines: z.array(draftLineSchema).max(MAX_LINES),
  }),
});

export type StagePhotoDraftInput = z.infer<typeof stagePhotoDraftSchema>;
