import { describe, expect, test } from 'bun:test';
import { normalizeTodoItems } from './toolRenderers';

describe('normalizeTodoItems', () => {
  test('preserves valid todo rows', () => {
    expect(normalizeTodoItems([
      { id: '1', content: 'Ship it', status: 'completed', priority: 'high' },
    ])).toEqual([
      { id: '1', content: 'Ship it', status: 'completed', priority: 'high' },
    ]);
  });

  test('drops malformed rows and unknown statuses', () => {
    expect(normalizeTodoItems([
      null,
      'todo',
      { content: { text: 'unsafe' }, status: 'pending' },
      { content: 'Unknown', status: 'blocked' },
      { content: 'Pending', status: 'pending', priority: { level: 'high' } },
    ])).toEqual([{ content: 'Pending', status: 'pending' }]);
  });

  test('returns an empty list for non-array runtime values', () => {
    expect(normalizeTodoItems({ content: 'not an array' })).toEqual([]);
  });
});
