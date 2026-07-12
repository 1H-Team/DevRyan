import { describe, expect, test } from 'bun:test';
import { normalizeInteractionUpdateToSdkMessage } from './index.js';

describe('normalizeInteractionUpdateToSdkMessage: tool calls', () => {
  test('preserves an explicit error status on a completed tool-call update', () => {
    const result = { status: 'error', error: { message: 'write denied' } };

    expect(normalizeInteractionUpdateToSdkMessage({
      type: 'tool-call-completed',
      callId: 'call_error',
      status: 'error',
      toolCall: {
        name: 'write',
        args: { path: 'src/file.ts' },
        result,
      },
    })).toEqual({
      type: 'tool_call',
      call_id: 'call_error',
      name: 'write',
      status: 'error',
      args: { path: 'src/file.ts' },
      result,
    });
  });

  test('defaults a completed update without an explicit status to completed', () => {
    expect(normalizeInteractionUpdateToSdkMessage({
      type: 'tool-call-completed',
      callId: 'call_complete',
      toolCall: { name: 'read', result: 'done' },
    })?.status).toBe('completed');
  });

  test('retains partial tool output while the call is running', () => {
    const result = { processed: 3, remaining: 2 };

    expect(normalizeInteractionUpdateToSdkMessage({
      type: 'partial-tool-call',
      callId: 'call_partial',
      status: 'running',
      toolCall: { name: 'task', result },
    })).toMatchObject({
      type: 'tool_call',
      call_id: 'call_partial',
      status: 'running',
      result,
    });
  });
});
