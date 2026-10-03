import { describe, expect, it } from 'vitest';
import { folderLabel, folderTreeOrder } from './tree';

const folders = [
  { id: 'b', name: 'Bread', parentId: null },
  { id: 'p', name: 'Pastry', parentId: null },
  { id: 't', name: 'Tarts', parentId: 'p' },
  { id: 'l', name: 'Lemon', parentId: 't' },
  { id: 'r', name: 'Rolls', parentId: 'b' },
  { id: 'o', name: 'Orphan', parentId: 'gone' },
];

describe('folderTreeOrder', () => {
  it('lists folders depth-first with their depth, keeping sibling order', () => {
    expect(folderTreeOrder(folders).map(({ folder, depth }) => `${depth}:${folder.name}`)).toEqual([
      '0:Bread',
      '1:Rolls',
      '0:Pastry',
      '1:Tarts',
      '2:Lemon',
      '0:Orphan',
    ]);
  });

  it('never loops on a corrupt cycle and still lists every folder once', () => {
    const cyclic = [
      { id: 'x', name: 'X', parentId: 'y' },
      { id: 'y', name: 'Y', parentId: 'x' },
    ];
    const order = folderTreeOrder(cyclic);
    expect(order.map(({ folder }) => folder.id).sort()).toEqual(['x', 'y']);
  });

  it('labels a nested folder with its full path', () => {
    expect(folderLabel(folders, 'l')).toBe('Pastry › Tarts › Lemon');
  });
});
