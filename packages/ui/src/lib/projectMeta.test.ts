import { describe, expect, test } from 'bun:test';

import { getProjectIconImageUrl } from './projectMeta';

describe('project icon image URL', () => {
  test('uses the shared image timestamp as a cache-busting version', () => {
    const first = getProjectIconImageUrl({
      id: 'project-1',
      iconImage: { mime: 'image/png', updatedAt: 100, source: 'custom' },
    });
    const updated = getProjectIconImageUrl({
      id: 'project-1',
      iconImage: { mime: 'image/png', updatedAt: 200, source: 'custom' },
    });

    expect(first).toBe('/api/projects/project-1/icon?v=100');
    expect(updated).toBe('/api/projects/project-1/icon?v=200');
  });
});
