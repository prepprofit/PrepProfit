import { describe, expect, it } from 'vitest';
import {
  compareRecentActivity,
  recentActivityAt,
  recipeSearchRank,
  searchLibrary,
} from '@/lib/recipes/library-order';

const d = (day: number) => new Date(Date.UTC(2026, 8, day, 12));

describe('recent activity', () => {
  it('takes the latest of edited and opened, falling back to created', () => {
    expect(recentActivityAt({ createdAt: d(1), updatedAt: d(1), lastOpenedAt: null })).toEqual(d(1));
    expect(recentActivityAt({ createdAt: d(1), updatedAt: d(5), lastOpenedAt: d(3) })).toEqual(d(5));
    expect(recentActivityAt({ createdAt: d(1), updatedAt: d(2), lastOpenedAt: d(9) })).toEqual(d(9));
  });

  it('orders newest activity first, then by name', () => {
    const rows = [
      { id: 'a', name: 'Brioche', recentActivityAt: d(2) },
      { id: 'b', name: 'Apple tart', recentActivityAt: d(2) },
      { id: 'c', name: 'Croissant', recentActivityAt: d(7) },
      { id: 'd', name: 'Danish', recentActivityAt: d(1) },
    ];
    expect([...rows].sort(compareRecentActivity).map((r) => r.name)).toEqual([
      'Croissant',
      'Apple tart',
      'Brioche',
      'Danish',
    ]);
  });
});

describe('library search', () => {
  it('ranks whole name, prefix, word prefix, then substring', () => {
    expect(recipeSearchRank('Crème pâtissière', 'creme patissiere')).toBe(0);
    expect(recipeSearchRank('Chocolate sponge', 'choc')).toBe(1);
    expect(recipeSearchRank('Dark chocolate ganache', 'choc gan')).toBe(2);
    expect(recipeSearchRank('Pistachio praline', 'aline')).toBe(3);
    expect(recipeSearchRank('Pistachio praline', 'vanilla')).toBe(Number.POSITIVE_INFINITY);
    expect(recipeSearchRank('Anything', '   ')).toBe(Number.POSITIVE_INFINITY);
  });

  it('searches every folder and uses recent activity as the tie-break', () => {
    const rows = [
      { id: '1', name: 'Chocolate mousse', folderId: 'desserts', recentActivityAt: d(1) },
      { id: '2', name: 'Chocolate sponge', folderId: null, recentActivityAt: d(8) },
      { id: '3', name: 'Dark chocolate ganache', folderId: 'bases', recentActivityAt: d(9) },
      { id: '4', name: 'Vanilla custard', folderId: 'bases', recentActivityAt: d(10) },
    ];
    expect(searchLibrary(rows, 'chocolate').map((r) => r.id)).toEqual(['2', '1', '3']);
    expect(searchLibrary(rows, 'zzz')).toEqual([]);
  });
});
