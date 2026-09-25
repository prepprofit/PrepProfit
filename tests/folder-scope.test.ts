import { describe, expect, it } from 'vitest';
import {
  folderScopeIds,
  recipesInFolderScope,
  rollUpFolderCounts,
} from '@/lib/folders/recipe-scope';

/**
 * Pure unit cover for the recursive folder scope — the read-side aggregation
 * both /recipes and /kitchen-scale browse with. The PGlite cover (the same
 * behaviour end-to-end through the data layer) lives in tests/folders.test.ts.
 */

// Wibox › Linda › Fillings, plus an unrelated top-level "Other".
const folders = [
  { id: 'wibox', name: 'Wibox', parentId: null },
  { id: 'linda', name: "Linda's", parentId: 'wibox' },
  { id: 'fillings', name: 'Fillings', parentId: 'linda' },
  { id: 'other', name: 'Other', parentId: null },
];

const recipes = [
  { id: 'r-linda', name: 'Ganache', folderId: 'linda' },
  { id: 'r-deep', name: 'Praline', folderId: 'fillings' },
  { id: 'r-other', name: 'Focaccia', folderId: 'other' },
  { id: 'r-unfiled', name: 'Loose', folderId: null },
];

describe('folderScopeIds', () => {
  it('covers the folder itself plus every descendant, at any depth', () => {
    expect([...folderScopeIds(folders, 'wibox')].sort()).toEqual(['fillings', 'linda', 'wibox']);
    expect([...folderScopeIds(folders, 'fillings')]).toEqual(['fillings']);
  });
});

describe('recipesInFolderScope', () => {
  it('finds a recipe three levels down from the top ancestor', () => {
    const rows = recipesInFolderScope(folders, recipes, { kind: 'folder', folderId: 'wibox' });
    expect(rows.map((r) => r.id)).toEqual(['r-linda', 'r-deep']);
  });

  it('lists a folder with NO direct recipes from its populated subfolders alone', () => {
    // Wibox itself holds nothing — everything it shows comes from below it.
    expect(recipes.filter((r) => r.folderId === 'wibox')).toHaveLength(0);
    expect(recipesInFolderScope(folders, recipes, { kind: 'folder', folderId: 'wibox' })).toHaveLength(2);
  });

  it('returns each recipe exactly once across nested folders', () => {
    const ids = recipesInFolderScope(folders, recipes, { kind: 'folder', folderId: 'wibox' }).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never leaks a sibling subtree, and keeps input (recent-activity) order', () => {
    expect(
      recipesInFolderScope(folders, recipes, { kind: 'folder', folderId: 'linda' }).map((r) => r.id),
    ).toEqual(['r-linda', 'r-deep']);
    expect(
      recipesInFolderScope(folders, recipes, { kind: 'folder', folderId: 'other' }).map((r) => r.id),
    ).toEqual(['r-other']);
  });

  it('scopes "unfiled" to folderId === null only, and "all" to everything', () => {
    expect(recipesInFolderScope(folders, recipes, { kind: 'unfiled' }).map((r) => r.id)).toEqual(['r-unfiled']);
    expect(recipesInFolderScope(folders, recipes, { kind: 'all' })).toHaveLength(4);
  });

  it('stays empty for a folder id that is not in this org\'s list', () => {
    // Cross-org safety net: an id the org's flat list does not contain resolves
    // to a scope of just that id, which no org-scoped recipe can match.
    const rows = recipesInFolderScope(folders, recipes, { kind: 'folder', folderId: 'other-org-folder' });
    expect(rows).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const before = JSON.stringify(recipes);
    recipesInFolderScope(folders, recipes, { kind: 'all' }).push({ id: 'x', name: 'x', folderId: null });
    expect(JSON.stringify(recipes)).toBe(before);
  });
});

describe('rollUpFolderCounts', () => {
  it('adds every descendant\'s direct count to each ancestor, counting a recipe once', () => {
    const totals = rollUpFolderCounts(
      folders,
      new Map([
        ['linda', 1],
        ['fillings', 1],
        ['other', 1],
      ]),
    );
    expect(totals.get('wibox')).toBe(2);
    expect(totals.get('linda')).toBe(2);
    expect(totals.get('fillings')).toBe(1);
    expect(totals.get('other')).toBe(1);
  });

  it('reports zero for a folder whose whole subtree is empty', () => {
    const totals = rollUpFolderCounts(folders, new Map());
    expect([...totals.values()]).toEqual([0, 0, 0, 0]);
  });

  it('survives a broken parent chain instead of looping forever', () => {
    const broken = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ];
    const totals = rollUpFolderCounts(broken, new Map([['a', 3]]));
    expect(totals.get('a')).toBe(3);
    expect(totals.get('b')).toBe(3);
  });
});
