import type {
  EvidenceAPI,
  EvidenceProjectSetting,
  TurnEvidenceCheckpoint,
  TurnEvidenceDiffSummary,
  TurnEvidenceFileDiff,
} from '@openchamber/ui/lib/api/types';
import { sendBridgeMessage } from './bridge';

export const createVSCodeEvidenceAPI = (): EvidenceAPI => ({
  getProjectSetting: (directory) => sendBridgeMessage<EvidenceProjectSetting>(
    'api:evidence/project:get',
    { directory },
  ),
  setProjectSetting: (directory, enabled) => sendBridgeMessage<EvidenceProjectSetting>(
    'api:evidence/project:set',
    { directory, enabled },
  ),
  clearProject: (directory) => sendBridgeMessage<{ removed: number }>(
    'api:evidence/project:clear',
    { directory },
  ),
  listTurns: (sessionID, directory) => sendBridgeMessage<TurnEvidenceCheckpoint[]>(
    'api:evidence/turns',
    { sessionID, directory },
  ),
  getDiff: (checkpointID, file) => sendBridgeMessage<
    TurnEvidenceDiffSummary | TurnEvidenceFileDiff
  >('api:evidence/diff', { checkpointID, file }),
});
