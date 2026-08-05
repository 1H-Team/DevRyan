import { describe, expect, it } from 'vitest';

import { emptySessionFolders, normalizeSessionFoldersPayload } from './session-folders.js';

describe('managed session folders', () => {
  it('normalizes the versioned payload without retaining unknown fields', () => {
    expect(normalizeSessionFoldersPayload({
      version: 1,
      foldersMap: {
        '/projects/project-1/developer': [{
          id: 'folder-1',
          name: 'Current work',
          sessionIds: ['session-1'],
          createdAt: 123,
          parentId: null,
          ignored: 'not persisted',
        }],
      },
      collapsedFolderIds: ['folder-1', 'folder-1'],
      updatedAt: 456,
      ignored: true,
    })).toEqual({
      version: 1,
      foldersMap: {
        '/projects/project-1/developer': [{
          id: 'folder-1',
          name: 'Current work',
          sessionIds: ['session-1'],
          createdAt: 123,
          parentId: null,
        }],
      },
      collapsedFolderIds: ['folder-1'],
      updatedAt: 456,
    });
  });

  it('provides an isolated empty document and rejects malformed data', () => {
    expect(emptySessionFolders()).toEqual({
      version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0,
    });
    expect(() => normalizeSessionFoldersPayload({
      version: 1, foldersMap: [], collapsedFolderIds: [], updatedAt: 0,
    })).toThrow('foldersMap must be an object');
    expect(() => normalizeSessionFoldersPayload({
      version: 2, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0,
    })).toThrow('Unsupported session folders version');
  });
});
