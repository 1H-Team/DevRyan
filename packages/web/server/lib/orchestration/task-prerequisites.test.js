import { expect, test } from 'vitest';
import { verifyTaskPrerequisites } from './task-prerequisites.js';

const hash = 'a'.repeat(64);
const producer = { taskId: 'dvr_task_producer', rootSessionId: 'ses_root', directory: '/project',
  dispatchObjectiveId: 'msg_objective', status: 'completed', priorTaskId: null,
  requiredChecks: [{ name: 'interface', command: 'bun test', paths: ['src/api.js'] }] };
const task = { rootSessionId: 'ses_root', directory: '/project', dispatchObjectiveId: 'msg_objective', taskPrerequisites: [
  { taskId: producer.taskId, checkName: 'interface', paths: ['src/api.js'], contentHash: hash },
] };
const verify = (item = producer, result = { status: 'passed', coverage: { contentHash: hash } }, input = task) =>
  verifyTaskPrerequisites(input, { listTasks: () => [item], project: async () => [{ name: 'interface', ...result }] });

test('requires a current passing producer check in the same objective and exact covered interface', async () => {
  expect(await verify()).toBe(true);
  for (const changed of [{ ...producer, status: 'running' }, { ...producer, directory: '/other' },
    { ...producer, dispatchObjectiveId: 'other' }, { ...producer, rootSessionId: 'other' }]) expect(await verify(changed)).toBe(false);
  for (const status of ['pending', 'failed', 'waived', 'blocked']) expect(await verify(producer, { status, coverage: { contentHash: hash } })).toBe(false);
  expect(await verify(producer, { status: 'passed', coverage: { contentHash: 'b'.repeat(64) } })).toBe(false);
  expect(await verify(producer, undefined, { ...task, taskPrerequisites: [{ ...task.taskPrerequisites[0], paths: ['other.js'] }] })).toBe(false);
  expect(await verify(producer, undefined, { ...task, dispatchObjectiveId: null })).toBe(false);
});
