import { describe, expect, test } from 'bun:test';
import {
  type CollapsibleSystemPart,
  collapseSystemInPlace,
  collapseSystemPartsInPlace,
} from './system-collapse';

/**
 * Regression tests for the system message collapse logic.
 *
 * PR #336's collapse was a silent no-op because it reassigned
 * output.system to a new array, but OpenCode core reads from the
 * original array reference. The fix mutates in-place.
 *
 * These tests import the actual shared function used by the hook,
 * so any regression in the implementation is caught immediately.
 */

describe('collapseSystemInPlace', () => {
  test('mutates multi-element array in-place', () => {
    const system = ['part one', 'part two'];
    const output = { system };

    collapseSystemInPlace(output.system);

    // Same reference - callers holding the original array see the change
    expect(output.system).toBe(system);
    expect(system).toHaveLength(1);
    expect(system[0]).toBe('part one\n\npart two');
  });

  test('mutates three-element array in-place', () => {
    const system = ['header', 'todo reminder', 'file nudge'];
    const output = { system };

    collapseSystemInPlace(output.system);

    expect(output.system).toBe(system);
    expect(system).toHaveLength(1);
    expect(system[0]).toBe('header\n\ntodo reminder\n\nfile nudge');
  });

  test('handles single-element array', () => {
    const system = ['only element'];
    const output = { system };

    collapseSystemInPlace(output.system);

    expect(output.system).toBe(system);
    expect(system).toHaveLength(1);
    expect(system[0]).toBe('only element');
  });

  test('handles empty array', () => {
    const system: string[] = [];
    const output = { system };

    collapseSystemInPlace(output.system);

    expect(output.system).toBe(system);
    expect(system).toHaveLength(0);
  });

  test('preserves previous empty-string cleanup behavior', () => {
    const system = [''];
    const output = { system };

    collapseSystemInPlace(output.system);

    expect(output.system).toBe(system);
    expect(system).toHaveLength(0);
  });

  test('reassignment would NOT be visible (regression guard)', () => {
    // This test documents WHY we mutate in-place and not via reassignment.
    // Simulating the broken PR #336 approach to prove it fails.
    const system = ['a', 'b'];
    const output = { system };

    // Broken approach: reassign the property
    output.system = [output.system.join('\n\n')];

    // The output object sees the new array...
    expect(output.system).toEqual(['a\n\nb']);

    // ...but the original reference is untouched - this is the bug.
    expect(system).toEqual(['a', 'b']);
    expect(system).not.toBe(output.system);
  });
});

describe('collapseSystemPartsInPlace', () => {
  const cached = { type: 'ephemeral' };
  const text = (value: string): CollapsibleSystemPart => ({
    type: 'text',
    text: value,
  });

  test('merges only neighbours that share a cache marker', () => {
    const parts: CollapsibleSystemPart[] = [
      text('agent'),
      text('env'),
      { type: 'text', text: 'project one', cache: cached, metadata: { a: 1 } },
      {
        type: 'text',
        text: 'project two',
        cache: { type: 'ephemeral' },
        metadata: { a: 2, b: 3 },
      },
      text('session'),
      { type: 'text', text: 'pinned', cache: cached },
    ];
    const original = parts;

    collapseSystemPartsInPlace(parts);

    expect(parts).toBe(original);
    expect(parts).toEqual([
      { type: 'text', text: 'agent\n\nenv' },
      {
        type: 'text',
        text: 'project one\n\nproject two',
        cache: cached,
        metadata: { a: 2, b: 3 },
      },
      { type: 'text', text: 'session' },
      { type: 'text', text: 'pinned', cache: cached },
    ]);
    // The merged run keeps the first part's marker instance.
    expect(parts[1]?.cache).toBe(cached);
  });

  test('never folds a cache-marked part into a volatile one', () => {
    const parts: CollapsibleSystemPart[] = [
      { type: 'text', text: 'stable', cache: cached },
      text('volatile'),
      { type: 'text', text: 'longer ttl', cache: { type: 'ephemeral', ttlSeconds: 3600 } },
      { type: 'text', text: 'default ttl', cache: cached },
    ];

    collapseSystemPartsInPlace(parts);

    expect(parts.map((part) => part.text)).toEqual([
      'stable',
      'volatile',
      'longer ttl',
      'default ttl',
    ]);
    expect(parts[0]?.cache).toBe(cached);
    expect(parts[1]?.cache).toBeUndefined();
  });

  test('keeps a lone part, metadata included, as the same object', () => {
    const lone: CollapsibleSystemPart = {
      type: 'text',
      text: 'instructions',
      metadata: { baseline: 'v1' },
    };
    const parts = [lone];

    collapseSystemPartsInPlace(parts);

    expect(parts).toEqual([lone]);
    expect(parts[0]).toBe(lone);
  });

  test('matches collapseSystemInPlace when no part has a marker', () => {
    for (const texts of [[], [''], ['a'], ['a', ''], ['', ''], ['a', 'b', 'c']]) {
      const strings = [...texts];
      const parts = texts.map(text);

      collapseSystemInPlace(strings);
      collapseSystemPartsInPlace(parts);

      expect(parts.map((part) => part.text)).toEqual(strings);
    }
  });
});
