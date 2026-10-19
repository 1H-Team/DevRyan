import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import { decodeManagedTaskToolPart } from './managedTaskToolPart';

const part = (state: unknown): ToolPart => ({
  id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_1', tool: 'devryan_task',
  state,
} as ToolPart);

describe('managed task tool part decoder', () => {

  test('decodes input, status, output task and follow-up task', () => {
    const view = decodeManagedTaskToolPart(part({
      status: 'completed', input: { action: ' retry ', agent: 'fixer', label: 'Fix', task_id: ' dvr_task_a ' },
      output: JSON.stringify({ task: { taskId: 'dvr_task_a' }, followUpTask: { task: { taskId: 'dvr_task_b' } } }),
    }));
    expect(view).toMatchObject({ action: 'retry', status: 'completed', agent: 'fixer', label: 'Fix', inputTaskId: 'dvr_task_a',
      outputTask: { taskId: 'dvr_task_a' }, followUpTask: { taskId: 'dvr_task_b' } });
  });

  test('parses the output once per part state across repeated projections', () => {
    const completed = (taskId: string): ToolPart['state'] => ({ status: 'completed', input: { action: 'start' }, title: '', metadata: {},
      time: { start: 1, end: 2 }, output: JSON.stringify({ task: { taskId } }) });
    const decoded = part(completed('dvr_task_a'));
    const original = JSON.parse;
    let parses = 0;
    JSON.parse = (text, reviver) => { parses += 1; return original(text, reviver); };
    try {
      for (let index = 0; index < 50; index += 1) decodeManagedTaskToolPart(decoded);
      expect(parses).toBe(1);
      // The reducer replaces state on update; a new state object is decoded afresh.
      decoded.state = completed('dvr_task_b');
      expect(decodeManagedTaskToolPart(decoded).outputTask).toEqual({ taskId: 'dvr_task_b' });
      expect(parses).toBe(2);
    } finally {
      JSON.parse = original;
    }
  });

  test('malformed, array and non-object outputs decode to null', () => {
    expect(decodeManagedTaskToolPart(part({ status: 'completed', input: {}, output: '{bad' })).output).toBeNull();
    expect(decodeManagedTaskToolPart(part({ status: 'completed', input: {}, output: '[1]' })).output).toBeNull();
    expect(decodeManagedTaskToolPart(part({ status: 'completed', input: {}, output: JSON.stringify({ task: [1] }) })).outputTask).toBeNull();
    expect(decodeManagedTaskToolPart(part(undefined))).toMatchObject({ action: '', status: '', output: null });
  });
});
