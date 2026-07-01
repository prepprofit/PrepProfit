import { describe, expect, it } from 'vitest';
import {
  parseInvoiceExtractionResponse,
  InvoiceExtractionError,
  supplierInvoiceExtractionSchema,
} from '@/lib/ai/invoice-extraction';
import {
  mapInvoiceExtractionToDraft,
  deriveInvoiceLineIssues,
  invoiceLineStatusFromIssues,
} from '@/lib/ai/invoice-draft';
import { validateDocumentUpload, PDF_MIME } from '@/lib/ai/document-upload';

/**
 * Pure tests for the Supplier Invoice Reader provider boundary (Sprint 2): the
 * untrusted-input Zod schema, the draft mapping (no silent loss), and the document
 * upload validation (image + PDF). No network / provider involved.
 */

function validExtraction() {
  return {
    supplier: { name: 'ACME Foods', confidence: 0.9 },
    invoice: { number: 'INV-1', date: '2026-07-01', currency: 'EUR' },
    lines: [
      {
        rawText: '6 x Butter 250g @ 1.20',
        itemName: 'Butter',
        quantityValue: 6,
        quantityUnit: 'case',
        packSizeValue: 250,
        packSizeUnit: 'g',
        unitPriceCents: 120,
        lineTotalCents: 720,
        confidence: 0.95,
      },
    ],
    qualityFlags: [],
  };
}

describe('supplierInvoiceExtractionSchema (untrusted boundary)', () => {
  it('accepts a well-formed extraction', () => {
    expect(supplierInvoiceExtractionSchema.safeParse(validExtraction()).success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const bad = validExtraction() as Record<string, unknown>;
    delete bad.qualityFlags;
    expect(supplierInvoiceExtractionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an impossible (negative) unit price', () => {
    const bad = validExtraction();
    bad.lines[0]!.unitPriceCents = -10;
    expect(supplierInvoiceExtractionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-integer price (cents must be integer)', () => {
    const bad = validExtraction();
    bad.lines[0]!.unitPriceCents = 12.5;
    expect(supplierInvoiceExtractionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a confidence out of [0,1]', () => {
    const bad = validExtraction();
    bad.lines[0]!.confidence = 1.5;
    expect(supplierInvoiceExtractionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects more than 300 lines (memory guard)', () => {
    const bad = validExtraction();
    bad.lines = Array.from({ length: 301 }, () => validExtraction().lines[0]!);
    expect(supplierInvoiceExtractionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('parseInvoiceExtractionResponse', () => {
  it('parses valid JSON', () => {
    const out = parseInvoiceExtractionResponse(JSON.stringify(validExtraction()));
    expect(out.supplier.name).toBe('ACME Foods');
    expect(out.lines).toHaveLength(1);
  });

  it('throws on non-JSON', () => {
    expect(() => parseInvoiceExtractionResponse('not json')).toThrow(InvoiceExtractionError);
  });

  it('throws on schema violation', () => {
    expect(() => parseInvoiceExtractionResponse('{"supplier":{}}')).toThrow(
      InvoiceExtractionError,
    );
  });
});

describe('line issue rules', () => {
  const complete = {
    itemNameRaw: 'Butter',
    quantityValue: 6,
    quantityUnit: 'case',
    packSizeValue: 5,
    packSizeUnit: 'kg',
    unitPriceCents: 970,
    lineTotalCents: 5820,
    matchedIngredientId: 'ing_1',
  };

  it('a complete + matched line is ready (no issues)', () => {
    const issues = deriveInvoiceLineIssues(complete);
    expect(issues).toEqual([]);
    expect(invoiceLineStatusFromIssues(issues)).toBe('ready');
  });

  it('flags missing quantity, pack, and price', () => {
    const issues = deriveInvoiceLineIssues({
      ...complete,
      quantityValue: null,
      packSizeValue: null,
      packSizeUnit: null,
      unitPriceCents: null,
    });
    expect(issues).toContain('MISSING_QUANTITY');
    expect(issues).toContain('MISSING_PACK');
    expect(issues).toContain('MISSING_PRICE');
    expect(invoiceLineStatusFromIssues(issues)).toBe('needs_review');
  });

  it('flags an unknown pack unit', () => {
    expect(deriveInvoiceLineIssues({ ...complete, packSizeUnit: 'blorg' })).toContain(
      'UNKNOWN_UNIT',
    );
  });

  it('flags a pack unit whose dimension mismatches the matched ingredient', () => {
    const issues = deriveInvoiceLineIssues(
      { ...complete, packSizeUnit: 'l' },
      { matchedDimension: 'weight' },
    );
    expect(issues).toContain('PACK_UNIT_MISMATCH');
  });

  it('flags no ingredient match', () => {
    expect(
      deriveInvoiceLineIssues({ ...complete, matchedIngredientId: null }),
    ).toContain('NO_INGREDIENT_MATCH');
  });

  it('a zero unit price is allowed (imports at 0, needs pricing) — not MISSING_PRICE', () => {
    const issues = deriveInvoiceLineIssues({ ...complete, unitPriceCents: 0 });
    expect(issues).not.toContain('MISSING_PRICE');
  });
});

describe('mapInvoiceExtractionToDraft (no silent loss)', () => {
  it('keeps every line and starts them unmatched → needs_review', () => {
    const draft = mapInvoiceExtractionToDraft(validExtraction());
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]!.status).toBe('needs_review');
    expect(draft.lines[0]!.issues).toContain('NO_INGREDIENT_MATCH');
    expect(draft.supplierNameRaw).toBe('ACME Foods');
    expect(draft.currencyCode).toBe('EUR');
  });

  it('normalizes a bad currency to null and flags currency_missing', () => {
    const ext = validExtraction();
    ext.invoice.currency = 'euros';
    const draft = mapInvoiceExtractionToDraft(ext);
    expect(draft.currencyCode).toBeNull();
    expect(draft.qualityFlags).toContain('currency_missing');
  });

  it('adds low-confidence flags derived from the extraction', () => {
    const ext = validExtraction();
    ext.supplier.confidence = 0.3;
    ext.lines[0]!.confidence = 0.2;
    const draft = mapInvoiceExtractionToDraft(ext);
    expect(draft.qualityFlags).toContain('low_supplier_confidence');
    expect(draft.qualityFlags).toContain('low_line_confidence');
  });
});

describe('validateDocumentUpload', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20)]);

  it('accepts a PDF by magic bytes', () => {
    const r = validateDocumentUpload(pdf, PDF_MIME);
    expect(r.ok && r.mime).toBe(PDF_MIME);
  });

  it('accepts a JPEG image', () => {
    const r = validateDocumentUpload(jpeg, 'image/jpeg');
    expect(r.ok && r.mime).toBe('image/jpeg');
  });

  it('rejects empty bytes', () => {
    expect(validateDocumentUpload(Buffer.alloc(0), '').ok).toBe(false);
  });

  it('rejects a script renamed .pdf (neither image nor %PDF-)', () => {
    const script = Buffer.from('#!/bin/sh\necho hi\n');
    const r = validateDocumentUpload(script, PDF_MIME);
    expect(r.ok).toBe(false);
  });

  it('rejects a mime that contradicts the sniffed bytes', () => {
    const r = validateDocumentUpload(pdf, 'image/png');
    expect(r.ok).toBe(false);
  });

  it('rejects an over-size document', () => {
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(9 * 1024 * 1024)]);
    const r = validateDocumentUpload(big, PDF_MIME);
    expect(r.ok).toBe(false);
  });
});
