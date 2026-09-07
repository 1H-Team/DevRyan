import { describe, expect, test } from 'bun:test';
import { createAccessibilityRefStore } from './refs.js';

describe('page-generation-fenced accessibility refs', () => {
  test('paginates a large Unicode snapshot below the gateway budget without losing refs or nodes', () => {
    const refs = createAccessibilityRefStore();
    const source = Array.from({ length: 1_500 }, (_, index) => ({
      backendNodeId: index + 1, role: 'link', name: `Contact ${index} ${'界'.repeat(200)}`,
    }));
    let page = refs.captureSnapshot(source);
    const all = [];
    const first = page;
    do {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(128 * 1024);
      all.push(...page.nodes);
      if (page.nextOffset === null) break;
      page = refs.pageSnapshot({ snapshotId: page.snapshotId, offset: page.nextOffset });
    } while (true);
    expect(all.map((node) => node.name)).toEqual(source.map((node) => node.name));
    expect(refs.resolve(all[0].ref).backendNodeId).toBe(1);
    expect(refs.resolve(all.at(-1).ref).backendNodeId).toBe(1_500);
    refs.captureSnapshot([]);
    expect(() => refs.pageSnapshot({ snapshotId: first.snapshotId })).toThrow(expect.objectContaining({ code: 'DEVRYAN_BOT_SNAPSHOT_STALE' }));
    expect(() => refs.resolve(all[0].ref)).toThrow();
  });

  test('reports bounded-cache omissions and text truncation explicitly', () => {
    const refs = createAccessibilityRefStore();
    const page = refs.captureSnapshot(Array.from({ length: 5_001 }, (_, index) => ({
      backendNodeId: index + 1, name: index === 0 ? 'a'.repeat(3_000) : 'Row',
    })));
    expect(page).toMatchObject({ totalNodes: 5_001, omittedNodes: 1 });
    expect(page.nodes[0].textTruncated).toBe(true);
    refs.beginPage();
    expect(() => refs.pageSnapshot({ snapshotId: page.snapshotId })).toThrow();
  });

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
