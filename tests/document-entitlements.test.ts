import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  GENERATED_DOCUMENTS,
  documentRequiresAdvanced,
  requireDocumentAccess,
  type GeneratedDocument,
} from '@/lib/entitlements';

/**
 * Locks the generated-document entitlement matrix (audit F-08). The boundary
 * between Business `advanced_documents` deliverables and free operational outputs
 * was previously implicit (each route hard-coded its own check); this test makes it
 * explicit so it can never drift silently. Changing who-can-download-what now
 * requires changing this test too.
 */

const hasMock = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ has: hasMock, orgId: 'org_test' })),
}));

describe('generated-document entitlement matrix', () => {
  it('financial reporting deliverables require advanced_documents', () => {
    const advanced: GeneratedDocument[] = ['pl_pdf', 'pl_xlsx', 'financials_print'];
    for (const doc of advanced) {
      expect(GENERATED_DOCUMENTS[doc]).toBe('advanced');
      expect(documentRequiresAdvanced(doc)).toBe(true);
    }
  });

  it('operational kitchen/purchasing outputs are free on every plan', () => {
    const operational: GeneratedDocument[] = [
      'recipe_card_pdf',
      'recipe_prep_card_pdf',
      'allergen_matrix_pdf',
      'allergen_matrix_xlsx',
      'purchase_order_pdf',
    ];
    for (const doc of operational) {
      expect(GENERATED_DOCUMENTS[doc]).toBe('operational');
      expect(documentRequiresAdvanced(doc)).toBe(false);
    }
  });

  it('every document in the matrix is classified exactly once', () => {
    for (const value of Object.values(GENERATED_DOCUMENTS)) {
      expect(['advanced', 'operational']).toContain(value);
    }
  });
});

describe('requireDocumentAccess gate', () => {
  beforeEach(() => hasMock.mockReset());
  afterEach(() => vi.clearAllMocks());

  it('blocks an advanced document when the plan lacks the feature', async () => {
    hasMock.mockReturnValue(false);
    expect(await requireDocumentAccess('pl_pdf')).toBe('UPGRADE_REQUIRED');
  });

  it('allows an advanced document when the plan has the feature', async () => {
    hasMock.mockImplementation(
      (arg?: { feature?: string }) => arg?.feature === 'advanced_documents',
    );
    expect(await requireDocumentAccess('pl_xlsx')).toBeNull();
  });

  it('never blocks an operational document, regardless of plan', async () => {
    hasMock.mockReturnValue(false);
    expect(await requireDocumentAccess('recipe_card_pdf')).toBeNull();
    expect(await requireDocumentAccess('purchase_order_pdf')).toBeNull();
  });
});
