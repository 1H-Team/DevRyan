import { afterEach, describe, expect, test } from 'bun:test';
import { sessionChangeCapturePaths } from './session-changes-tools.js';

const part = (tool, input) => ({ type: 'tool', tool, state: { status: 'running', input } });
const envelope = ['*** Begin Patch', '*** Update File: src/a.ts', '@@', '-old', '+new',
  '*** Add File: src/new file.ts', '+content', '*** Delete File: src/gone.ts',
  '*** Update File: src/from.ts', '*** Move to: src/to.ts', '@@', '-x', '+y', '*** End Patch'].join('\n');

describe('files observed around a file tool', () => {
  afterEach(() => { delete process.env.DEVRYAN_PATCH_CAPTURE_PATHS; });

  test('a patch envelope is observed at the files its headers name', () => {
    expect(sessionChangeCapturePaths(part('apply_patch', { patchText: envelope })))
      .toEqual(['src/a.ts', 'src/new file.ts', 'src/gone.ts', 'src/from.ts', 'src/to.ts']);
    expect(sessionChangeCapturePaths(part('oc_apply_patch', { patch: envelope.replaceAll('\n', '\r\n') })))
      .toEqual(['src/a.ts', 'src/new file.ts', 'src/gone.ts', 'src/from.ts', 'src/to.ts']);
  });

  test('any other patch keeps the whole-project observation', () => {
    for (const input of [undefined, {}, { patchText: '' }, { patchText: '*** Begin Patch\n*** End Patch' },
      { patchText: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' },
      // A header outside an envelope is only text.
      { patchText: '*** Update File: src/a.ts\n@@\n-old\n+new' },
      { patchText: `*** Begin Patch\n${Array.from({ length: 513 }, (_, index) => `*** Add File: f${index}.ts\n+x`).join('\n')}\n*** End Patch` },
    ]) expect(sessionChangeCapturePaths(part('apply_patch', input))).toBeNull();
    process.env.DEVRYAN_PATCH_CAPTURE_PATHS = '0';
    expect(sessionChangeCapturePaths(part('apply_patch', { patchText: envelope }))).toBeNull();
  });

  test('single-file tools keep their declared target and other tools the whole project', () => {
    expect(sessionChangeCapturePaths(part('edit', { filePath: 'src/a.ts' }))).toEqual(['src/a.ts']);
    expect(sessionChangeCapturePaths(part('write', { filePath: 'src/b.ts' }))).toEqual(['src/b.ts']);
    expect(sessionChangeCapturePaths(part('multiedit', { filePath: 'src/c.ts' }))).toEqual(['src/c.ts']);
    expect(sessionChangeCapturePaths(part('bash', { command: 'touch x' }))).toBeNull();
    expect(sessionChangeCapturePaths(part('read', { filePath: 'src/a.ts' }))).toBeNull();
  });
});
