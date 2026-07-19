import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { resolveRoutedSessionDirectory } from './routedSessionDirectory';

const session = (id: string, directory?: string, parentID?: string): Session => ({
  id,
  title: id,
  time: { created: 1, updated: 1 },
  ...(directory ? { directory } : {}),
  ...(parentID ? { parentID } : {}),
} as Session);

describe('resolveRoutedSessionDirectory', () => {
  test('prefers the live routing source and normalizes separators', () => {
    expect(resolveRoutedSessionDirectory('session', 'C:\\repo\\child\\', [
      session('session', '/stale'),
    ])).toBe('C:/repo/child');
  });

  test('resolves cold global sessions and no-directory children', () => {
    const parent = session('parent', '/repo');
    const child = session('child', undefined, parent.id);
    expect(resolveRoutedSessionDirectory(child.id, null, [parent, child])).toBe('/repo');
  });

  test('returns null until authoritative session metadata is available', () => {
    expect(resolveRoutedSessionDirectory('missing', null, [])).toBeNull();
  });
});
