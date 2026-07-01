import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/db';
import { runInOrg } from '@/lib/db/tenant';
import type { TenantDb } from '@/lib/db/tenant';
import { ingredientPriceHistory } from '@/lib/db/schema';
import { createIngredient, getIngredientById } from '@/lib/data/ingredients';
import { mapInvoiceExtractionToDraft } from '@/lib/ai/invoice-draft';
import type { SupplierInvoiceExtraction } from '@/lib/ai/invoice-extraction';
import {
  createInvoiceImport,
  getInvoiceImport,
  updateInvoiceLine,
  applyInvoiceImport,
  voidInvoiceImport,
} from '@/lib/data/supplier-invoice-imports';

/**
 * Data-layer tests for supplier invoice imports (Sprint 2). THE key property: applying
 * an import records a PENDING `source='import'` observation and NEVER changes the
 * approved `price_cents`. Also covers pre-matching, review edits, currency guard, the
 * empty guard, idempotency, void, and cross-org isolation.
 */

const ORG_A = 'org_inv_a';
const ORG_B = 'org_inv_b';

let client: PGlite;
let db: TenantDb;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  db = test.db as unknown as TenantDb;
});

afterAll(async () => {
  await client.close();
});

/** Build a validated extraction with a butter line + an incomplete line. */
function extraction(currency: string | null = 'EUR'): SupplierInvoiceExtraction {
  return {
    supplier: { name: 'ACME Foods', confidence: 0.9 },
    invoice: { number: 'INV-1', date: '2026-07-01', currency },
    lines: [
      {
        rawText: 'Butter 5kg sack',
        itemName: 'Butter',
        quantityValue: 1,
        quantityUnit: 'case',
        packSizeValue: 5,
        packSizeUnit: 'kg',
        unitPriceCents: 970,
        lineTotalCents: 970,
        confidence: 0.95,
      },
      {
        rawText: 'mystery item',
        itemName: 'Mystery Item',
        quantityValue: null,
        quantityUnit: null,
        packSizeValue: null,
        packSizeUnit: null,
        unitPriceCents: null,
        lineTotalCents: null,
        confidence: 0.4,
      },
    ],
    qualityFlags: [],
  };
}

async function seedButter(org: string, priceCents = 500): Promise<string> {
  const ing = await runInOrg(db, org, (tx) =>
    createIngredient(tx, org, { name: 'Butter', dimension: 'weight', priceCents }),
  );
  return ing.id;
}

describe('createInvoiceImport (pre-matching + status)', () => {
  it('exact-matches Butter → ready, leaves the unmatched line needs_review', async () => {
    await seedButter(ORG_A);
    const draft = mapInvoiceExtractionToDraft(extraction());
    const result = await runInOrg(db, ORG_A, (tx) =>
      createInvoiceImport(tx, ORG_A, { actorUserId: 'u', aiAttemptId: null, draft }),
    );
    expect(result.total).toBe(2);
    expect(result.ready).toBe(1);
    expect(result.needsReview).toBe(1);

    const view = await runInOrg(db, ORG_A, (tx) =>
      getInvoiceImport(tx, ORG_A, result.importId),
    );
    const butterLine = view!.lines.find((l) => l.itemNameRaw === 'Butter');
    expect(butterLine!.status).toBe('ready');
    expect(butterLine!.matchedIngredientId).not.toBeNull();
  });
});

describe('applyInvoiceImport (PENDING observations only — the safety contract)', () => {
  it('raises pending_price_cents + writes source=import history, never touches price_cents', async () => {
    const ingId = await seedButter(ORG_A, 500);
    const draft = mapInvoiceExtractionToDraft(extraction('EUR'));
    const { importId } = await runInOrg(db, ORG_A, (tx) =>
      createInvoiceImport(tx, ORG_A, { actorUserId: 'u', aiAttemptId: null, draft }),
    );

    const res = await runInOrg(db, ORG_A, (tx) =>
      applyInvoiceImport(tx, ORG_A, 'u', importId, 'EUR'),
    );
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.applied).toBe(1);

    const ing = await runInOrg(db, ORG_A, (tx) => getIngredientById(tx, ORG_A, ingId));
    // Approved cost is UNTOUCHED; a pending observation is raised.
    expect(ing!.priceCents).toBe(500);
    expect(ing!.pendingPriceCents).not.toBeNull();

    const history = await runInOrg(db, ORG_A, (tx) =>
      tx
        .select()
        .from(ingredientPriceHistory)
        .where(
          and(
            eq(ingredientPriceHistory.organizationId, ORG_A),
            eq(ingredientPriceHistory.ingredientId, ingId),
          ),
        ),
    );
    expect(history).toHaveLength(1);
    expect(history[0]!.source).toBe('import');
    expect(history[0]!.accepted).toBe(false);

    // Idempotent: the import is now `applied`, so re-apply is refused.
    const again = await runInOrg(db, ORG_A, (tx) =>
      applyInvoiceImport(tx, ORG_A, 'u', importId, 'EUR'),
    );
    expect(again.status).toBe('not_editable');
  });

  it('refuses when the invoice currency differs from the org currency (D6)', async () => {
    await seedButter(ORG_A);
    const draft = mapInvoiceExtractionToDraft(extraction('EUR'));
    const { importId } = await runInOrg(db, ORG_A, (tx) =>
      createInvoiceImport(tx, ORG_A, { actorUserId: 'u', aiAttemptId: null, draft }),
    );
    const res = await runInOrg(db, ORG_A, (tx) =>
      applyInvoiceImport(tx, ORG_A, 'u', importId, 'USD'),
    );
    expect(res.status).toBe('currency_mismatch');
  });

  it('refuses an import with no ready lines (empty)', async () => {
    // No Butter ingredient in this org → the butter line cannot match → both lines
    // are needs_review, so nothing is ready.
    const org = 'org_inv_empty';
    const draft = mapInvoiceExtractionToDraft(extraction('EUR'));
    const { importId } = await runInOrg(db, org, (tx) =>
      createInvoiceImport(tx, org, { actorUserId: 'u', aiAttemptId: null, draft }),
    );
    const res = await runInOrg(db, org, (tx) =>
      applyInvoiceImport(tx, org, 'u', importId, 'EUR'),
    );
    expect(res.status).toBe('empty');
  });
});

describe('updateInvoiceLine (review edits)', () => {
  it('matching an ingredient + completing the line flips it to ready', async () => {
    const org = 'org_inv_edit';
    const ingId = await runInOrg(db, org, (tx) =>
      createIngredient(tx, org, { name: 'Flour', dimension: 'weight', priceCents: 0 }),
    ).then((i) => i.id);

    // Draft whose line does NOT exact-match (so it starts needs_review).
    const ext = extraction('EUR');
    ext.lines = [
      {
        rawText: 'plain flour 25kg',
        itemName: 'Plain Flour',
        quantityValue: 1,
        quantityUnit: 'sack',
        packSizeValue: 25,
        packSizeUnit: 'kg',
        unitPriceCents: 1800,
        lineTotalCents: 1800,
        confidence: 0.8,
      },
    ];
    const draft = mapInvoiceExtractionToDraft(ext);
    const { importId } = await runInOrg(db, org, (tx) =>
      createInvoiceImport(tx, org, { actorUserId: 'u', aiAttemptId: null, draft }),
    );
    const view = await runInOrg(db, org, (tx) => getInvoiceImport(tx, org, importId));
    const lineId = view!.lines[0]!.id;
    expect(view!.lines[0]!.status).toBe('needs_review');

    const res = await runInOrg(db, org, (tx) =>
      updateInvoiceLine(tx, org, importId, lineId, { matchedIngredientId: ingId }),
    );
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.line.status).toBe('ready');
  });

  it('ignoring a line excludes it (status ignored)', async () => {
    const org = 'org_inv_ignore';
    await runInOrg(db, org, (tx) =>
      createIngredient(tx, org, { name: 'Butter', dimension: 'weight', priceCents: 0 }),
    );
    const draft = mapInvoiceExtractionToDraft(extraction('EUR'));
    const { importId } = await runInOrg(db, org, (tx) =>
      createInvoiceImport(tx, org, { actorUserId: 'u', aiAttemptId: null, draft }),
    );
    const view = await runInOrg(db, org, (tx) => getInvoiceImport(tx, org, importId));
    const lineId = view!.lines[0]!.id;

    const res = await runInOrg(db, org, (tx) =>
      updateInvoiceLine(tx, org, importId, lineId, { ignored: true }),
    );
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.line.status).toBe('ignored');
  });
});

describe('void + cross-org isolation', () => {
  it('voids a draft, then refuses further edits/apply', async () => {
    const org = 'org_inv_void';
    const draft = mapInvoiceExtractionToDraft(extraction('EUR'));
    const { importId } = await runInOrg(db, org, (tx) =>
      createInvoiceImport(tx, org, { actorUserId: 'u', aiAttemptId: null, draft }),
    );
    expect(
      (await runInOrg(db, org, (tx) => voidInvoiceImport(tx, org, importId))).status,
    ).toBe('ok');
    expect(
      (await runInOrg(db, org, (tx) => applyInvoiceImport(tx, org, 'u', importId, 'EUR')))
        .status,
    ).toBe('not_editable');
  });

  it('an import created in org A is invisible / not applicable from org B', async () => {
    await seedButter(ORG_A);
    const draft = mapInvoiceExtractionToDraft(extraction('EUR'));
    const { importId } = await runInOrg(db, ORG_A, (tx) =>
      createInvoiceImport(tx, ORG_A, { actorUserId: 'u', aiAttemptId: null, draft }),
    );

    const seenByB = await runInOrg(db, ORG_B, (tx) =>
      getInvoiceImport(tx, ORG_B, importId),
    );
    expect(seenByB).toBeNull();

    const appliedByB = await runInOrg(db, ORG_B, (tx) =>
      applyInvoiceImport(tx, ORG_B, 'u', importId, 'EUR'),
    );
    expect(appliedByB.status).toBe('not_found');
  });
});
