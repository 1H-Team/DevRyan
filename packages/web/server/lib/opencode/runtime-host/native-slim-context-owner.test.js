import { expect, test, vi } from 'vitest';
import { formatReviewedSlimTaskBoard } from '../../../../../agents-core/src/devryan/task-board.ts';
import { createNativeSlimContextOwner } from './native-slim-context-owner.js';

test('an interrupted attempt never reappears as running/resumed after its failed retry is collected', async () => {
  const directory = '/fixture', sessionID = 'ses_root', at = Date.now();
  const original = { taskId: 'dvr_task_original', rootSessionId: sessionID, childSessionId: 'ses_child', agent: 'fixer',
    label: 'Implement Phase 1', status: 'interrupted', attempt: 1, createdAt: at - 100, startedAt: at - 90, finishedAt: at - 20,
    failureReason: 'Stream idle timeout' };
  const retry = { ...original, taskId: 'dvr_task_retry', status: 'failed', attempt: 2, createdAt: at - 15,
    startedAt: at - 10, finishedAt: at - 5, failureReason: 'native_web_principal_required' };
  const tasks = [original, retry];
  const envelopes = tasks.map((task, index) => ({ taskId: task.taskId, sequence: index + 1, resumable: index === 0,
    action: index === 0 ? 'retry_in_place' : 'collect', promptObserved: { attempt: task.attempt, sequence: index + 1 } }));
  const format = vi.fn(formatReviewedSlimTaskBoard);
  const renders = [];
  const owner = createNativeSlimContextOwner({ locations: [{ directory }],
    admissionOwner: { captureSessionHookAuthorization: async () => async () => {} },
    openCodeClient: { sessions: { get: async () => ({ id: sessionID, directory }) } },
    primaryRuntime: { readRecord: async () => ({ sessionID, directory, agent: 'orchestrator', state: 'running' }) },
    getManagedRuntime: () => ({ withNativePromptContext: async (_scope, action) => action({ tasks, envelopes, markPromptObserved: vi.fn() }) }),
    originals: { formatReviewedSlimTaskBoard: format,
      createReviewedSlimTaskBoardRenderer: ({ board }) => ({ clearSession() {}, transform: async () => {
        renders.push(board.formatForPromptWithMetadata(sessionID));
      } }),
    },
  });
  const transform = () => owner.transformMessages({ phase: 'context', sessionID, directory, messages: [] });
  await transform();
  const jobs = format.mock.calls[0][0].jobs;
  expect(jobs.map(job => [job.taskID, job.state, job.terminalState, job.terminalUnreconciled])).toEqual([
    ['dvr_task_original', 'reconciled', 'stopped', false], ['dvr_task_retry', 'reconciled', 'error', false],
  ]);
  expect(renders[0]?.text).toContain('No running managed tasks');
  expect(renders[0]?.text).not.toContain('[resumed]');
  // An unobserved interrupted result is still surfaced truthfully for collection.
  envelopes[0] = { ...envelopes[0], action: null, promptObserved: null };
  await transform();
  expect(renders[1]?.text).toContain('stopped, unreconciled');
  expect(renders[1]?.text).not.toContain('running');
  envelopes[0] = { ...envelopes[0], action: 'retry_in_place', promptObserved: { attempt: 1, sequence: 1 } };
  // A genuine scheduler-owned follow-up still renders as active.
  tasks.push({ ...retry, taskId: 'dvr_task_live', status: 'running', attempt: 3, finishedAt: null });
  await transform();
  expect(renders[2]?.text).toContain('dvr_task_live');
  expect(renders[2]?.text).toContain('running [resumed]');
});
