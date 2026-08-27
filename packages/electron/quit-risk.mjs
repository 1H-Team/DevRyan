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
  hasActiveBotRuns: false,
  hasPendingBotApprovals: false,
  activeBotRunCount: 0,
  pendingBotApprovalCount: 0,
  activeBotRoutineCount: 0,
  pendingBotRoutineCount: 0,
  hasPendingBotRoutines: false,
  botRoutineSchedulerStatus: 'idle',
  hasBotRoutineSchedulerRisk: false,
  botCheckpointStatus: 'idle',
  hasBotCheckpointRisk: false,
  verificationFailed: false,
});

export const buildQuitRiskSnapshot = ({
  scheduledTasks,
  tunnel,
  bots,
  scheduledTasksVerified = true,
  tunnelVerified = true,
  botsVerified = true,
} = {}) => {
  const runningCount = scheduledTasksVerified
    ? toCount(scheduledTasks?.runningScheduledTasksCount)
    : 0;
  const pendingCount = scheduledTasksVerified
    ? toCount(scheduledTasks?.pendingScheduledTasksCount)
    : 0;
  const activeBotRunCount = botsVerified ? toCount(bots?.activeRunCount) : 0;
  const pendingBotApprovalCount = botsVerified ? toCount(bots?.pendingApprovalCount) : 0;
  const activeBotRoutineCount = botsVerified ? toCount(bots?.activeRoutineCount) : 0;
  const pendingBotRoutineCount = botsVerified ? toCount(bots?.pendingRoutineCount) : 0;
  const rawSchedulerStatus = botsVerified && typeof bots?.schedulerStatus === 'string'
    ? bots.schedulerStatus.trim().toLowerCase()
    : (botsVerified ? 'idle' : 'unknown');
  const botRoutineSchedulerStatus = [
    'idle',
    'active',
    'checkpointing',
    'stopped',
    'unavailable',
    'unknown',
  ].includes(rawSchedulerStatus) ? rawSchedulerStatus : 'unknown';
  const hasBotRoutineSchedulerRisk = ['checkpointing', 'unavailable', 'unknown']
    .includes(botRoutineSchedulerStatus)
    || (botRoutineSchedulerStatus === 'stopped' && activeBotRoutineCount > 0);
  const rawCheckpointStatus = botsVerified && typeof bots?.checkpointStatus === 'string'
    ? bots.checkpointStatus.trim().toLowerCase()
    : (botsVerified ? 'idle' : 'unknown');
  const botCheckpointStatus = [
    'idle',
    'complete',
    'pending',
    'checkpointing',
    'failed',
    'unknown',
  ].includes(rawCheckpointStatus) ? rawCheckpointStatus : 'unknown';
  const hasBotCheckpointRisk = ['pending', 'checkpointing', 'failed', 'unknown']
    .includes(botCheckpointStatus);

  return {
    hasActiveTunnel: tunnelVerified && tunnel?.active === true,
    hasRunningScheduledTasks: scheduledTasksVerified
      && (scheduledTasks?.hasRunningScheduledTasks === true || runningCount > 0),
    hasPendingScheduledTasks: scheduledTasksVerified
      && (scheduledTasks?.hasPendingScheduledTasks === true || pendingCount > 0),
    runningScheduledTasksCount: runningCount,
    pendingScheduledTasksCount: pendingCount,
    hasActiveBotRuns: activeBotRunCount > 0,
    hasPendingBotApprovals: pendingBotApprovalCount > 0,
    activeBotRunCount,
    pendingBotApprovalCount,
    activeBotRoutineCount,
    pendingBotRoutineCount,
    hasPendingBotRoutines: pendingBotRoutineCount > 0,
    botRoutineSchedulerStatus,
    hasBotRoutineSchedulerRisk,
    botCheckpointStatus,
    hasBotCheckpointRisk,
    verificationFailed: !scheduledTasksVerified || !tunnelVerified || !botsVerified,
  };
};

export const shouldRequireQuitConfirmation = (quitRisk) => (
  quitRisk.hasActiveTunnel
  || quitRisk.hasRunningScheduledTasks
  || quitRisk.hasPendingScheduledTasks
  || quitRisk.hasActiveBotRuns
  || quitRisk.hasPendingBotApprovals
  || quitRisk.hasPendingBotRoutines
  || quitRisk.hasBotRoutineSchedulerRisk
  || quitRisk.hasBotCheckpointRisk
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
  if (quitRisk.activeBotRunCount > 0) {
    reasons.push(`${quitRisk.activeBotRunCount} active Bot run${quitRisk.activeBotRunCount === 1 ? '' : 's'}`);
  }
  if (quitRisk.pendingBotApprovalCount > 0) {
    reasons.push(`${quitRisk.pendingBotApprovalCount} pending Bot approval${quitRisk.pendingBotApprovalCount === 1 ? '' : 's'}`);
  }
  if (quitRisk.pendingBotRoutineCount > 0) {
    reasons.push(`${quitRisk.pendingBotRoutineCount} due Bot routine occurrence${quitRisk.pendingBotRoutineCount === 1 ? '' : 's'}`);
  }
  if (quitRisk.hasBotRoutineSchedulerRisk) {
    reasons.push(`the Bot routine scheduler is ${quitRisk.botRoutineSchedulerStatus}`);
  }
  if (quitRisk.hasBotCheckpointRisk) {
    reasons.push(`the Bot checkpoint is ${quitRisk.botCheckpointStatus}`);
  }
  if (quitRisk.verificationFailed) {
    reasons.push('background activity that could not be verified');
  }
  if (reasons.length === 0) {
    return 'Background processes (sidecar, SSH sessions) will be stopped.';
  }
  return `DevRyan detected ${reasons.join(', ')}. Quitting now will checkpoint Bot runs, stop owned background processes, and may interrupt pending work.`;
};
