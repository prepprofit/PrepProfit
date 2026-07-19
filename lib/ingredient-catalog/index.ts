import rawCatalog from './data/catalog.json';
import { catalogSchema, type CatalogEntry } from './schema';
import { searchCatalogEntries } from './search';

/**
 * Server-side entry point for the seed ingredient catalogue. The dataset is
 * validated once per process (fail-fast on a bad data PR) and searched in
 * memory — nothing here touches the DB and the JSON must never be imported
 * from client components (it would ship ~1.9k entries to the browser).
 */

let cached: readonly CatalogEntry[] | null = null;

export function getIngredientCatalog(): readonly CatalogEntry[] {
  if (!cached) cached = catalogSchema.parse(rawCatalog);
  return cached;
}

export function getCatalogEntry(id: string): CatalogEntry | null {
  return getIngredientCatalog().find((entry) => entry.id === id) ?? null;
}

export function searchIngredientCatalog(
  term: string,
  limit = 20,
): CatalogEntry[] {
  return searchCatalogEntries(getIngredientCatalog(), term, limit);
}
