import { expect, test } from 'bun:test';
import type { BackgroundJobRecord } from '../utils/background-job-board';
import { formatReviewedSlimTaskBoard } from './task-board';

const job = (overrides: Partial<BackgroundJobRecord>): BackgroundJobRecord => ({
  taskID: 'dvr_task_one', parentSessionID: 'ses_root', alias: 'dvr_task_one', agent: 'fixer',
  description: 'Fix the parser', objective: 'Fix the parser', state: 'completed', generation: 1, taskGeneration: 1,
  terminalRevision: 3, activityRevision: 0, background: true, timedOut: false, recoverableAfterLiveBusy: false,
  statusUncertain: false, cancellationRequested: false, terminalUnreconciled: false, launchedAt: 1, lastLaunchedAt: 1,
  runStartedAt: 1, updatedAt: 2, lastUsedAt: 2, contextFiles: [], ...overrides,
});

test('the host board names devryan_task actions and renders labels, never objectives or Slim tools', () => {
  const completed = job({ terminalState: 'completed' });
  const stopped = job({ taskID: 'dvr_task_two', alias: 'dvr_task_two', state: 'stopped', description: 'Review the parser',
    objective: 'FULL OBJECTIVE TEXT that must stay out of the prompt' });
  const failed = job({ taskID: 'dvr_task_three', alias: 'dvr_task_three', state: 'error', terminalUnreconciled: true,
    terminalState: 'error', description: 'Run the checks', objective: 'FULL OBJECTIVE TEXT' });
  const input = { jobs: [completed, stopped, failed], reusable: [completed] };
  const board = formatReviewedSlimTaskBoard({ ...input, now: 10 });
  expect(board?.text).toContain('devryan_task wait or wait_any');
  expect(board?.text).toContain('Completed children accept only continue.');
  expect(board?.text).toContain('stopped, retry, resume or abandon');
  expect(board?.text).toContain('Label: Review the parser');
  for (const absent of ['task_revive', 'task_result', 'subagent(', 'Objective:', 'FULL OBJECTIVE TEXT'])
    expect(board?.text).not.toContain(absent);
  // Time only filters aged rows; it never changes the rendered text.
  expect(formatReviewedSlimTaskBoard({ ...input, now: 20 })?.text).toBe(board?.text);
});
