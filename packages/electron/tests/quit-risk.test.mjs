import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQuitRiskSnapshot,
  emptyQuitRisk,
  quitConfirmationMessage,
  shouldRequireQuitConfirmation,
} from '../quit-risk.mjs';

test('does not require confirmation without verified quit risks', () => {
  const snapshot = buildQuitRiskSnapshot({
    scheduledTasks: {
      hasPendingScheduledTasks: false,
      hasRunningScheduledTasks: false,
      pendingScheduledTasksCount: 0,
      runningScheduledTasksCount: 0,
      enabledScheduledTasksCount: 4,
    },
    tunnel: { active: false },
  });

  assert.equal(shouldRequireQuitConfirmation(snapshot), false);
  assert.equal(snapshot.pendingScheduledTasksCount, 0);
});

test('formats genuine scheduled-task and tunnel risks', () => {
  const snapshot = buildQuitRiskSnapshot({
    scheduledTasks: {
      pendingScheduledTasksCount: 2,
      runningScheduledTasksCount: 1,
    },
    tunnel: { active: true },
  });

  assert.equal(shouldRequireQuitConfirmation(snapshot), true);
  assert.match(quitConfirmationMessage(snapshot), /an active tunnel/);
  assert.match(quitConfirmationMessage(snapshot), /1 running scheduled task/);
  assert.match(quitConfirmationMessage(snapshot), /2 pending scheduled tasks/);
});

test('failed verification clears stale task counts and reports uncertainty', () => {
  const snapshot = emptyQuitRisk();
  Object.assign(snapshot, buildQuitRiskSnapshot({
    scheduledTasks: { pendingScheduledTasksCount: 1 },
    tunnel: { active: false },
  }));
  Object.assign(snapshot, buildQuitRiskSnapshot({
    scheduledTasksVerified: false,
    tunnelVerified: false,
  }));

  assert.equal(snapshot.pendingScheduledTasksCount, 0);
  assert.equal(snapshot.runningScheduledTasksCount, 0);
  assert.equal(snapshot.verificationFailed, true);
  assert.doesNotMatch(quitConfirmationMessage(snapshot), /1 pending scheduled task/);
  assert.match(quitConfirmationMessage(snapshot), /could not be verified/);
});
