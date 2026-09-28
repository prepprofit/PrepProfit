import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readIngredientListView,
  saveIngredientListView,
} from '@/lib/ingredients/list-view-state';

/**
 * The ingredient list parks its browsing context on the current history entry before a
 * recipe link is followed. Round-trips through a fake History API, and refuses anything
 * malformed (a stale or foreign history.state must mean "start fresh", never a crash).
 */
function fakeWindow(initial: unknown = null) {
  const history = {
    state: initial as unknown,
    replaceState: vi.fn((state: unknown) => {
      history.state = state;
    }),
  };
  vi.stubGlobal('window', { history });
  return history;
}

afterEach(() => vi.unstubAllGlobals());

const view = {
  query: 'almond',
  sort: { column: 'price', direction: 'desc', attentionFirst: false },
  scrollTop: 420,
  detailsId: 'ing_1',
} as const;

describe('ingredient list view state', () => {
  it('round-trips search, sort, scroll and the open popup, keeping other history state', () => {
    const history = fakeWindow({ __NA: true, keep: 1 });
    saveIngredientListView(view);
    expect(history.state).toMatchObject({ __NA: true, keep: 1 });
    expect(readIngredientListView()).toEqual(view);
  });

  it('returns null when nothing was parked', () => {
    fakeWindow(null);
    expect(readIngredientListView()).toBeNull();
    fakeWindow({ __NA: true });
    expect(readIngredientListView()).toBeNull();
  });

  it('rejects malformed values', () => {
    for (const bad of [
      { ...view, query: 5 },
      { ...view, scrollTop: Number.NaN },
      { ...view, sort: { column: 'nope', direction: 'asc' } },
      { ...view, sort: { column: 'name', direction: 'sideways' } },
      { ...view, detailsId: 7 },
      'string',
    ]) {
      fakeWindow({ ingredientListView: bad });
      expect(readIngredientListView()).toBeNull();
    }
  });

  it('never throws when the History API is unavailable', () => {
    vi.stubGlobal('window', {
      history: {
        get state(): unknown {
          throw new Error('denied');
        },
        replaceState() {
          throw new Error('denied');
        },
      },
    });
    expect(() => saveIngredientListView(view)).not.toThrow();
    expect(readIngredientListView()).toBeNull();
  });
});
