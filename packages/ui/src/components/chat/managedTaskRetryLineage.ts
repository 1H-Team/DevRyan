import type { ManagedTaskResultEnvelope } from '@openchamber/orchestration-runtime';

export const getSameChildFollowUpTaskId = (
  resultEnvelope?: Pick<ManagedTaskResultEnvelope, 'action' | 'followUpTaskId'>,
) => (
  (
    resultEnvelope?.action === 'resume'
    || resultEnvelope?.action === 'recover_in_place'
    || resultEnvelope?.action === 'retry_in_place'
  )
    && resultEnvelope.followUpTaskId
    ? resultEnvelope.followUpTaskId
    : null
);
