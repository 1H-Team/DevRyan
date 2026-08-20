import { describe, expect, test } from 'bun:test';
import { normalizeInteractionUpdateToSdkMessage } from './interaction-update-normalize.js';
import {
  mergeCursorNativeTaskActivity,
  sanitizeCursorTaskResult,
} from './cursor-native-task.js';

describe('Cursor native task activity', () => {
  test('normalizes one-level task text and tool activity', () => {
    expect(normalizeInteractionUpdateToSdkMessage({
      type: 'tool-call-delta',
      callId: 'parent-task',
      modelCallId: 'model-call',
      taskUpdate: { type: 'text-delta', text: 'Inspecting the runtime' },
    })).toEqual({
      type: 'task_activity',
      call_id: 'parent-task',
      model_call_id: 'model-call',
      update: { type: 'text-delta', text: 'Inspecting the runtime' },
    });

    expect(normalizeInteractionUpdateToSdkMessage({
      type: 'tool-call-delta',
      callId: 'parent-task',
      modelCallId: 'model-call',
      taskUpdate: {
        type: 'tool-call-started',
        callId: 'nested-read',
        toolCall: { type: 'read', args: { path: 'src/main.ts' } },
      },
    })).toEqual({
      type: 'task_activity',
      call_id: 'parent-task',
      model_call_id: 'model-call',
      update: {
        type: 'tool-call',
        call_id: 'nested-read',
        name: 'read',
        status: 'running',
        args: { path: 'src/main.ts' },
      },
    });

    expect(normalizeInteractionUpdateToSdkMessage({
      type: 'tool-call-delta',
      callId: 'parent-task',
      modelCallId: 'model-call',
      taskUpdate: {
        type: 'tool-call-completed',
        callId: 'nested-read',
        toolCall: {
          type: 'read',
          result: { status: 'error', error: { message: 'denied' } },
        },
      },
    })?.update).toMatchObject({
      type: 'tool-call',
      call_id: 'nested-read',
      status: 'error',
    });
  });

  test('drops malformed and deeper nested task activity', () => {
    expect(normalizeInteractionUpdateToSdkMessage({
      type: 'tool-call-delta',
      callId: 'parent-task',
      taskUpdate: {
        type: 'tool-call-delta',
        callId: 'deeper-task',
        taskUpdate: { type: 'text-delta', text: 'hidden' },
      },
    })).toBeNull();
    expect(normalizeInteractionUpdateToSdkMessage({
      type: 'tool-call-delta',
      taskUpdate: { type: 'text-delta', text: 'missing parent' },
    })).toBeNull();
  });

  test('coalesces text and nested tool updates into a bounded projection', () => {
    let projection = mergeCursorNativeTaskActivity(null, {
      type: 'task_activity',
      call_id: 'parent-task',
      model_call_id: 'model-call',
      update: { type: 'text-delta', text: 'Inspecting ' },
    });
    projection = mergeCursorNativeTaskActivity(projection, {
      type: 'task_activity',
      call_id: 'parent-task',
      model_call_id: 'model-call',
      update: { type: 'text-delta', text: 'files' },
    });
    projection = mergeCursorNativeTaskActivity(projection, {
      type: 'task_activity',
      call_id: 'parent-task',
      update: {
        type: 'tool-call',
        call_id: 'nested-read',
        name: 'read',
        status: 'running',
        args: { path: 'src/main.ts' },
      },
    });
    projection = mergeCursorNativeTaskActivity(projection, {
      type: 'task_activity',
      call_id: 'parent-task',
      update: { type: 'step-started', step_id: 0 },
    });
    projection = mergeCursorNativeTaskActivity(projection, {
      type: 'task_activity',
      call_id: 'parent-task',
      update: {
        type: 'tool-call',
        call_id: 'nested-read',
        name: 'read',
        status: 'completed',
        result: { status: 'success' },
      },
    });

    expect(projection.text).toBe('Inspecting files');
    expect(projection.entries).toEqual([{
      id: 'nested-read',
      tool: 'read',
      state: {
        status: 'completed',
        input: { path: 'src/main.ts' },
        output: { status: 'success' },
      },
    }]);
    expect(projection.stepCount).toBe(1);

    for (let index = 0; index < 30; index += 1) {
      projection = mergeCursorNativeTaskActivity(projection, {
        type: 'task_activity',
        call_id: 'parent-task',
        update: {
          type: 'tool-call',
          call_id: `nested-${index}`,
          name: 'read',
          status: 'completed',
        },
      });
    }
    expect(projection.entries).toHaveLength(24);
    expect(projection.truncated).toBe(true);
  });

  test('does not persist Cursor transcript paths or unbounded conversation steps', () => {
    expect(sanitizeCursorTaskResult({
      status: 'success',
      value: {
        agentId: 'agent-1',
        resultSuffix: 'Done',
        transcriptPath: '/Users/example/private/transcript.jsonl',
        conversationSteps: [{ huge: true }],
      },
    })).toEqual({
      status: 'success',
      value: { agentId: 'agent-1', resultSuffix: 'Done' },
    });

    expect(normalizeInteractionUpdateToSdkMessage({
      type: 'tool-call-delta',
      callId: 'parent-task',
      taskUpdate: {
        type: 'tool-call-completed',
        callId: 'nested-task',
        toolCall: {
          type: 'task',
          result: {
            status: 'success',
            value: {
              resultSuffix: 'Nested done',
              transcriptPath: '/Users/example/private/nested.jsonl',
              conversationSteps: [{ private: true }],
            },
          },
        },
      },
    })?.update).toMatchObject({
      result: {
        status: 'success',
        value: { resultSuffix: 'Nested done' },
      },
    });
  });
});
