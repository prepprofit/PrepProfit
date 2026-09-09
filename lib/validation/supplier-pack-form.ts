import { parseMoneyToCents } from '@/lib/format/money';

/**
 * Pure field-level rules for the ingredient supplier dialog (`ingredient-supplier-dialog.tsx`).
 *
 * It lives outside the component for one reason: this is the rule that stands
 * between a manager and a dead-end Save button, so it has to be testable without
 * rendering anything. It must also agree EXACTLY with the payload the dialog
 * builds — a field the dialog would drop must not be reported as valid here.
 *
 * The rule (decision D1, `docs/supplier-dialog-ux-plan.md`):
 *
 *   • A supplier NAME alone is a legitimate record — "I know who supplies this,
 *     I don't know the pack yet". It saves. The server schema and
 *     `tests/suppliers.test.ts` already protect that flow.
 *   • The pack trio (size / unit / price) travels together or not at all: a half
 *     pack cannot produce a cost per unit, and a price with no pack is rejected
 *     by both the Zod schema and the DB CHECK.
 *
 * The TRIGGER for the trio is `packSize` or `packPrice` — never `packUnit`. The
 * unit select is PRE-FILLED from the ingredient's dimension when the dialog opens,
 * so letting it trigger would mark every untouched form incomplete and delete the
 * name-only flow the decision exists to keep.
 */

/** Every field the dialog can mark. Keys match the inputs, not the payload. */
export type SupplierPackField =
  | 'supplierName'
  | 'unitsPerPack'
  | 'packSize'
  | 'packUnit'
  | 'packPrice';

/** Stable codes, mapped 1:1 to `suppliers.ingredientEditor.fieldErrors.*`. */
export type SupplierPackErrorCode =
  | 'supplierRequired'
  | 'unitsInvalid'
  | 'packSizeRequired'
  | 'packSizeInvalid'
  | 'packUnitRequired'
  | 'priceRequired'
  | 'priceInvalid';

export type SupplierPackFormValues = {
  supplierName: string;
  unitsPerPack: string;
  packSize: string;
  packUnit: string;
  packPrice: string;
};

export type SupplierPackFormErrors = Partial<
  Record<SupplierPackField, SupplierPackErrorCode>
>;

/**
 * True once the manager has started describing the pack. Only the two TYPED
 * fields count — see the note about the pre-filled unit select above.
 */
export function isPackStarted(values: SupplierPackFormValues): boolean {
  return values.packSize.trim() !== '' || values.packPrice.trim() !== '';
}

/** Field errors for the current form state. Empty object = saveable. */
export function validateSupplierPackForm(
  values: SupplierPackFormValues,
): SupplierPackFormErrors {
  const errors: SupplierPackFormErrors = {};

  if (values.supplierName.trim() === '') errors.supplierName = 'supplierRequired';

  // Nothing about the pack typed yet → a name-only link, which is complete.
  if (!isPackStarted(values)) return errors;

  const sizeText = values.packSize.trim();
  if (sizeText === '') {
    errors.packSize = 'packSizeRequired';
  } else {
    // `Number` — not a locale-aware parse — because that is exactly what the
    // dialog sends. A comma decimal is NaN there, so it must fail here too
    // rather than pass validation and be silently dropped from the payload.
    const size = Number(sizeText);
    if (!Number.isFinite(size) || size <= 0) errors.packSize = 'packSizeInvalid';
  }

  if (values.packUnit.trim() === '') errors.packUnit = 'packUnitRequired';

  const priceText = values.packPrice.trim();
  if (priceText === '') {
    errors.packPrice = 'priceRequired';
  } else if (parseMoneyToCents(priceText) <= 0) {
    // `parseMoneyToCents` yields 0 for unparseable text, so this catches both
    // garbage and a real zero — either way the ingredient would cost at zero.
    errors.packPrice = 'priceInvalid';
  }

  // Case quantity: a pack always has one, and the field is seeded to "1".
  const units = Number(values.unitsPerPack.trim());
  if (!Number.isInteger(units) || units <= 0) errors.unitsPerPack = 'unitsInvalid';

  return errors;
}

/**
 * Save is blocked ONLY by a half-described pack — a state the manager created and
 * can see marked inline. A missing supplier name stays clickable so the button is
 * never mysteriously dead on an untouched form; the click reveals its inline error.
 */
export function isPackBlockingSave(errors: SupplierPackFormErrors): boolean {
  return (
    errors.packSize !== undefined ||
    errors.packUnit !== undefined ||
    errors.packPrice !== undefined ||
    errors.unitsPerPack !== undefined
  );
}
