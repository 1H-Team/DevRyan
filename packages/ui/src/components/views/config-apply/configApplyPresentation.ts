import type { ConfigApplyStatus } from '@/stores/useConfigApplyStore';

export const getConfigApplyStatusText = (status: ConfigApplyStatus): string => {
  switch (status.state) {
    case 'pending':
      return 'Saved — changes pending.';
    case 'waiting_for_idle':
      return status.activeSessionCount === 1
        ? 'Waiting for 1 active chat to finish.'
        : `Waiting for ${status.activeSessionCount} active chats to finish.`;
    case 'applying':
      return 'Restarting OpenCode…';
    case 'failed':
      return status.lastError?.message || 'OpenCode restart failed. Saved changes are still pending.';
    case 'external_restart_required':
      return 'Saved — restart the external OpenCode runtime to apply these changes.';
    case 'clean':
    default:
      return '';
  }
};
