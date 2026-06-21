import type { AllergenMatrixData, AllergenMatrixLabels } from './types';
import {
  type Cell,
  type Sheet,
  emptyCell,
  headerCell,
  renderXlsx,
  textCell,
} from './xlsx';

/**
 * Kitchen allergen matrix Excel export (Sprint 9). `buildAllergenMatrixRows` is pure
 * (testable for exact cells + formula-injection neutralization); `renderAllergenMatrixXlsx`
 * is the thin Node renderer. MONEY-FREE — there are no `moneyCell`s here; every cell
 * is text (recipe names + presence markers), neutralized against formula injection by
 * the shared helpers. The disclaimer is the first row.
 */
export function buildAllergenMatrixRows(
  data: AllergenMatrixData,
  labels: AllergenMatrixLabels,
): Cell[][] {
  const rows: Cell[][] = [];

  rows.push([headerCell(labels.title)]);
  rows.push([textCell(labels.generatedOn), textCell(data.generatedOn)]);
  rows.push([textCell(labels.disclaimer)]);
  rows.push([emptyCell]);

  if (data.rows.length === 0 || data.allergens.length === 0) {
    rows.push([textCell(labels.noAllergensRecorded)]);
    return rows;
  }

  // Header: recipe + one column per present allergen.
  rows.push([
    headerCell(labels.recipe),
    ...data.allergens.map((slug) => headerCell(labels.allergenLabels[slug])),
  ]);

  for (const row of data.rows) {
    const name = row.hasUnreviewedIngredient
      ? `${row.recipeName} (${labels.unreviewed})`
      : row.recipeName;
    const cells: Cell[] = [textCell(name)];
    for (const slug of data.allergens) {
      const presence = row.cells[slug];
      cells.push(presence ? textCell(labels.presence[presence]) : emptyCell);
    }
    rows.push(cells);
  }

  return rows;
}

export function renderAllergenMatrixXlsx(
  data: AllergenMatrixData,
  labels: AllergenMatrixLabels,
): Promise<Buffer> {
  const sheet: Sheet = {
    name: labels.title,
    rows: buildAllergenMatrixRows(data, labels),
    columns: [{ width: 36 }, ...data.allergens.map(() => ({ width: 16 }))],
  };
  return renderXlsx([sheet]);
}
