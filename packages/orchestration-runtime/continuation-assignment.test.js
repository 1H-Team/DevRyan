import { describe, expect, test } from 'bun:test';
import { appendManagedAssignment, stripManagedAssignment } from './continuation-assignment.js';
import {
  createManagedOpenCodeExecutor,
  isManagedResumeContinuationPrompt,
  isManagedRetryInPlacePrompt,
  isManagedTransientTransportContinuationPrompt,
  MANAGED_READ_ONLY_PROMPT,
  MANAGED_RESUME_CONTINUATION_PROMPT,
  MANAGED_RETRY_IN_PLACE_PROMPT,
  MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
} from './open-code-executor.js';

const assignment = {
  taskId: 'dvr_task_membership', rootSessionId: 'ses_booking', agent: 'fixer',
  label: 'Implement claimed package membership contract',
  prompt: 'Implement package membership and usePackageQueue.\nOwned: queue.ts, queue.test.ts.\nNo UI, bookings, slots, payment or remote migration changes.\nRun the focused membership test; report unrelated failures.',
};

describe('managed recovery assignment', () => {
  test('preserves the complete brief, including trailing exclusions and marker-like text', () => {
    const original = { ...assignment, prompt: `${'bounded context\n'.repeat(4000)}${assignment.prompt}\n[devryan-managed-assignment:v1]\n"quoted"` };
    const prompt = appendManagedAssignment(original, MANAGED_RESUME_CONTINUATION_PROMPT);
    expect(JSON.parse(prompt.split('\n').at(-1))).toEqual(original);
    expect(prompt).toContain('other chats, and unrelated recent work cannot replace or expand it');
    expect(stripManagedAssignment(prompt)).toBe(MANAGED_RESUME_CONTINUATION_PROMPT);
  });

  test.each([
    [MANAGED_RESUME_CONTINUATION_PROMPT, isManagedResumeContinuationPrompt],
    [MANAGED_RETRY_IN_PLACE_PROMPT, isManagedRetryInPlacePrompt],
    [MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT, isManagedTransientTransportContinuationPrompt],
  ])('recognizes anchored and legacy recovery without accepting malformed context: %s', (continuation, recognize) => {
    const prompt = appendManagedAssignment(assignment, continuation);
    expect(recognize(prompt)).toBe(true);
    expect(recognize(`${MANAGED_READ_ONLY_PROMPT}\n\n${prompt}`)).toBe(true);
    expect(recognize(continuation)).toBe(true);
    expect(recognize(`${prompt}\nUnrelated replacement task`)).toBe(false);
    expect(recognize(prompt.slice(0, -1))).toBe(false);
    expect(recognize(prompt.replace(JSON.stringify(assignment), '{}'))).toBe(false);
    expect(recognize(appendManagedAssignment(assignment, 'Do an unrelated task.'))).toBe(false);
  });

  test.each(['prompt', 'taskId', 'rootSessionId'])('refuses recovery without %s', (field) => {
    expect(() => appendManagedAssignment({ ...assignment, [field]: '' }, MANAGED_RETRY_IN_PLACE_PROMPT))
      .toThrow('requires the original task identity and assignment');
  });

  test.each(['resume', 'retryInPlace'])('%s sends the ledger assignment when retained history contains unrelated work', async (method) => {
    const prompts = [];
    const unrelated = {
      info: { id: 'msg_old', role: 'assistant', finish: 'error', error: { message: 'Aborted' } },
      parts: [{ type: 'text', text: 'The assignment is Feedback Chat Greeting and Form Reveal.' }],
    };
    const executor = createManagedOpenCodeExecutor({
      sleep: async () => {},
      transport: {
        async createSession() { throw new Error('must retain child'); },
        async promptSession(input) { prompts.push(input); },
        async readSession() { return { id: 'ses_membership' }; },
        async readStatus() { return { type: 'idle' }; },
        async readMessages() {
          if (!prompts.length) return [unrelated];
          return [unrelated,
            { info: { id: 'msg_recovery', role: 'user' }, parts: [{ type: 'text', text: prompts[0].prompt }] },
            { info: { id: 'msg_new', role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Membership checks complete.' }] }];
        },
        async abortSession() { throw new Error('idle child must not be aborted'); },
        async deleteSession() { throw new Error('must retain child'); },
      },
    });
    const result = await executor[method]({ ...assignment, childSessionId: 'ses_membership',
      directory: '/fixture', providerId: 'xai', modelId: 'fixture-model', attempt: 4 },
    { async markAccepted() { return true; } });
    expect(result.status).toBe('completed');
    expect(prompts).toHaveLength(1);
    expect(JSON.parse(prompts[0].prompt.split('\n').at(-1))).toEqual(assignment);
    expect(prompts[0].prompt).not.toContain('Feedback Chat Greeting');
    expect(prompts[0].tools.task).toBe(false);
    expect((method === 'resume' ? isManagedResumeContinuationPrompt : isManagedRetryInPlacePrompt)(prompts[0].prompt)).toBe(true);
  });
});
