import { expect, test } from 'bun:test';
import { cursorToolReceiptMetadata } from './cursor-tool-receipts.js';
import { normalizeInteractionUpdateToSdkMessage } from './interaction-update-normalize.js';

test('preserves executed Cursor edits from the pinned SDK result union', () => {
  const diff = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const message = normalizeInteractionUpdateToSdkMessage({ type: 'tool-call-completed', callId: 'native-call',
    toolCall: { type: 'edit', args: { path: 'file.ts' }, result: { status: 'success', value: { linesAdded: 1, linesRemoved: 1, diffString: diff } } } });
  expect(message.call_id).toBe('native-call');
  expect(cursorToolReceiptMetadata(message)).toEqual({ diff });
});

test('does not fabricate receipts from requested writes, counts, failures, or partial updates', () => {
  expect(cursorToolReceiptMetadata({ name: 'write', status: 'completed', args: { path: 'file.ts', fileText: 'requested' },
    result: { status: 'success', value: { path: 'file.ts', linesCreated: 1, fileSize: 9 } } })).toEqual({});
  for (const status of ['running', 'error']) expect(cursorToolReceiptMetadata({ name: 'edit', status,
    result: { status: 'success', value: { diffString: 'patch' } } })).toEqual({});
  expect(cursorToolReceiptMetadata({ name: 'edit', status: 'completed', result: { status: 'error', error: 'denied' } })).toEqual({});
});
