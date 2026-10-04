import { expect, it } from 'vitest';
import { createManagedAssistantActivityRegistry, createManagedOpenCodeExecutor } from '@openchamber/orchestration-runtime';
import { createEventProjector } from '../opencode/v2/projection/events.js';

it.each([true, false])('a warm native projector recognizes real activity without inventing it (streaming: %s)', async streaming => {
  let clock = 1000, reads = 0, aborts = 0;
  const registry = createManagedAssistantActivityRegistry({ now: () => clock });
  const projector = createEventProjector({ now: () => clock });
  // The projector saw the assistant before the executor's observation began.
  // Its subsequent deltas correctly do not re-announce that metadata.
  projector.project({ id: 'evt_started', created: clock, type: 'session.step.started', location: { directory: '/repo' },
    data: { sessionID: 'ses_child', assistantMessageID: 'msg_current', agent: 'explorer', model: { providerID: 'fixture', id: 'model' } } });
  const progress = [], projectedTypes = [];
  const executor = createManagedOpenCodeExecutor({
    transport: {
      createSession: async () => { throw new Error('No new session'); },
      promptSession: async () => { throw new Error('No new prompt'); },
      readSession: async () => ({ id: 'ses_child' }),
      readStatus: async () => ({ type: ++reads <= 6 ? 'busy' : 'idle' }),
      readMessages: async () => [{ info: { id: 'msg_current', role: 'assistant',
        time: { created: 1000, ...(reads <= 6 ? {} : { completed: clock }) },
        ...(reads <= 6 ? {} : { finish: 'stop' }) }, parts: [{ type: 'text', text: reads <= 6 ? '' : 'Complete' }] }],
      abortSession: async () => { aborts++; throw new Error('silent child abort'); },
      deleteSession: async () => true,
    },
    now: () => clock,
    sleep: async () => {
      clock += 100;
      if (!streaming) return;
      for (const event of projector.project({ id: `evt_${clock}`, created: clock, type: 'session.text.delta', location: { directory: '/repo' },
        data: { sessionID: 'ses_child', assistantMessageID: 'msg_current', ordinal: 0, delta: '.' } })) {
        projectedTypes.push(event.payload.type); registry.observe(event.payload, event.directory);
      }
    },
    subscribeAssistantActivity: registry.subscribe,
    bindAssistantActivity: registry.bind,
    pollIntervalMs: 0, liveTranscriptRefreshMs: 0, liveProgressTimeoutMs: 150, idleStablePolls: 1,
  });
  try {
    const result = await executor.observe({ owner: 'devryan', taskId: 'dvr_warm', rootSessionId: 'ses_root', childSessionId: 'ses_child',
      directory: '/repo', mode: 'orchestrator', status: 'running', agent: 'explorer', providerId: 'fixture', modelId: 'model',
      prompt: 'Complete the fixture.', label: 'Warm projector', leaseToken: 'dvr_lease', attempt: 1, executionKind: 'start',
      createdAt: 1000, startedAt: 1000, canonicalRefs: [] }, { recordProgress: async value => { progress.push(value); return true; } });
    expect(result.status).toBe(streaming ? 'completed' : 'interrupted');
    expect(aborts).toBe(streaming ? 0 : 1);
    expect(projectedTypes).not.toContain('message.updated');
    expect(progress.filter(value => 'firstAssistantPartAt' in value)).toEqual(streaming ? [{ firstAssistantPartAt: 1100 }] : []);
  } finally { await executor.shutdown(); }
});
