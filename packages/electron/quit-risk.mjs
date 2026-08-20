const toCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
};

export const emptyQuitRisk = () => ({
  hasActiveTunnel: false,
  hasRunningScheduledTasks: false,
  hasPendingScheduledTasks: false,
  runningScheduledTasksCount: 0,
  pendingScheduledTasksCount: 0,
  verificationFailed: false,
});

export const buildQuitRiskSnapshot = ({
  scheduledTasks,
  tunnel,
  scheduledTasksVerified = true,
  tunnelVerified = true,
} = {}) => {
  const runningCount = scheduledTasksVerified
    ? toCount(scheduledTasks?.runningScheduledTasksCount)
    : 0;
  const pendingCount = scheduledTasksVerified
    ? toCount(scheduledTasks?.pendingScheduledTasksCount)
    : 0;

  return {
    hasActiveTunnel: tunnelVerified && tunnel?.active === true,
    hasRunningScheduledTasks: scheduledTasksVerified
      && (scheduledTasks?.hasRunningScheduledTasks === true || runningCount > 0),
    hasPendingScheduledTasks: scheduledTasksVerified
      && (scheduledTasks?.hasPendingScheduledTasks === true || pendingCount > 0),
    runningScheduledTasksCount: runningCount,
    pendingScheduledTasksCount: pendingCount,
    verificationFailed: !scheduledTasksVerified || !tunnelVerified,
  };
};

export const shouldRequireQuitConfirmation = (quitRisk) => (
  quitRisk.hasActiveTunnel
  || quitRisk.hasRunningScheduledTasks
  || quitRisk.hasPendingScheduledTasks
  || quitRisk.verificationFailed
);

export const quitConfirmationMessage = (quitRisk) => {
  const reasons = [];
  if (quitRisk.hasActiveTunnel) {
    reasons.push('an active tunnel');
  }
  if (quitRisk.runningScheduledTasksCount > 0) {
    reasons.push(`${quitRisk.runningScheduledTasksCount} running scheduled task${quitRisk.runningScheduledTasksCount === 1 ? '' : 's'}`);
  }
  if (quitRisk.pendingScheduledTasksCount > 0) {
    reasons.push(`${quitRisk.pendingScheduledTasksCount} pending scheduled task${quitRisk.pendingScheduledTasksCount === 1 ? '' : 's'}`);
  }
  if (quitRisk.verificationFailed) {
    reasons.push('background activity that could not be verified');
  }
  if (reasons.length === 0) {
    return 'Background processes (sidecar, SSH sessions) will be stopped.';
  }
  return `DevRyan detected ${reasons.join(', ')}. Quitting now will stop sidecar/background processes and may interrupt pending work.`;
};
