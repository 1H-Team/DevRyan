import { describe, expect, test } from 'bun:test';
import { createAccessibilityRefStore } from './refs.js';

describe('page-generation-fenced accessibility refs', () => {
  test('projects opaque refs without exposing backend DOM IDs', () => {
    const refs = createAccessibilityRefStore({ randomBytes: () => Buffer.alloc(8, 1) });
    refs.beginPage();
    const snapshot = refs.recordSnapshot([{
      backendNodeId: 42,
      role: 'button',
      name: 'Save',
      value: '',
    }]);
    expect(snapshot).toEqual([{
      ref: 'ref_1_0101010101010101',
      role: 'button',
      name: 'Save',
      value: '',
      disabled: false,
      focused: false,
    }]);
    expect(refs.resolve(snapshot[0].ref).backendNodeId).toBe(42);
  });

  test('invalidates every old ref when navigation advances the generation', () => {
    const refs = createAccessibilityRefStore({ randomBytes: () => Buffer.alloc(8, 2) });
    refs.beginPage();
    const [node] = refs.recordSnapshot([{ backendNodeId: 7, role: 'link', name: 'Next' }]);
    refs.beginPage();
    expect(() => refs.resolve(node.ref)).toThrow(expect.objectContaining({
      code: 'DEVRYAN_BOT_REF_STALE',
    }));
  });
});
