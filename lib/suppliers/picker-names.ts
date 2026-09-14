/**
 * Every supplier name the ingredient supplier picker offers: the business's active
 * supplier RECORDS plus names already written on ingredients (imports stored free
 * text that never became a record — saving one through the dialog creates it).
 * Deduped case-insensitively, keeping the record's spelling first, and sorted A→Z
 * locale-aware so "Myllärin" sits with the Ms rather than at the top.
 */
export function supplierPickerNames(
  recordNames: readonly string[],
  ingredientSupplierNames: readonly (string | null)[],
): string[] {
  const byKey = new Map<string, string>();
  for (const raw of [...recordNames, ...ingredientSupplierNames]) {
    const name = raw?.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  }
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return [...byKey.values()].sort(collator.compare);
}
