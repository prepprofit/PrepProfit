import type { PlDocumentData, PlDocumentLabels } from './types';
import {
  type Cell,
  type Sheet,
  emptyCell,
  headerCell,
  moneyCell,
  renderXlsx,
  textCell,
} from './xlsx';

/**
 * P&L Excel export (Sprint 3.5B). `buildPlSheetRows` is pure (testable for exact
 * cell values + formula-injection neutralization); `renderPlXlsx` is the thin Node
 * renderer. Money cells are real Numbers (cents / 100) so Excel can sum them; every
 * text cell is neutralized against formula injection by the shared helpers.
 */
export function buildPlSheetRows(
  data: PlDocumentData,
  labels: PlDocumentLabels,
): Cell[][] {
  const rows: Cell[][] = [];

  // Title + period.
  rows.push([headerCell(labels.title)]);
  rows.push([textCell(labels.period), textCell(data.periodLabel)]);
  rows.push([emptyCell]);

  // Summary.
  rows.push([headerCell(labels.income), headerCell(labels.expenses), headerCell(labels.profit)]);
  rows.push([
    moneyCell(data.incomeCents),
    moneyCell(data.expenseCents),
    moneyCell(data.profitCents),
  ]);
  rows.push([emptyCell]);

  // By category.
  rows.push([headerCell(labels.byCategory)]);
  rows.push([headerCell(labels.category), headerCell(labels.amount)]);
  if (data.byCategory.length === 0) {
    rows.push([textCell(labels.empty)]);
  } else {
    for (const c of data.byCategory) {
      rows.push([textCell(c.name), moneyCell(c.totalCents)]);
    }
  }
  rows.push([emptyCell]);

  // Top products.
  rows.push([headerCell(labels.topProducts)]);
  rows.push([headerCell(labels.product), headerCell(labels.amount)]);
  if (data.topProducts.length === 0) {
    rows.push([textCell(labels.empty)]);
  } else {
    for (const p of data.topProducts) {
      rows.push([textCell(p.name), moneyCell(p.totalCents)]);
    }
  }

  // Monthly breakdown (year view only).
  if (data.monthly) {
    rows.push([emptyCell]);
    rows.push([headerCell(labels.monthly)]);
    rows.push([
      headerCell(labels.month),
      headerCell(labels.income),
      headerCell(labels.expenses),
      headerCell(labels.profit),
    ]);
    for (const m of data.monthly) {
      rows.push([
        textCell(m.label),
        moneyCell(m.incomeCents),
        moneyCell(m.expenseCents),
        moneyCell(m.profitCents),
      ]);
    }
  }

  return rows;
}

export function renderPlXlsx(
  data: PlDocumentData,
  labels: PlDocumentLabels,
): Promise<Buffer> {
  const sheet: Sheet = {
    name: labels.title,
    rows: buildPlSheetRows(data, labels),
    columns: [{ width: 32 }, { width: 16 }, { width: 16 }, { width: 16 }],
  };
  return renderXlsx([sheet]);
}
