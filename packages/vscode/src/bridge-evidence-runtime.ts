import type { BridgeResponse } from './bridge';
import { getVsCodeHarnessRuntime } from './harness-runtime-access';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

const payloadRecord = (payload: unknown): Record<string, unknown> => (
  payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
);

const requiredString = (value: unknown, label: string): string => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
};

export async function handleEvidenceBridgeMessage(
  message: BridgeMessageInput,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;
  if (!type.startsWith('api:evidence/')) return null;
  const runtime = getVsCodeHarnessRuntime();
  if (!runtime) return { id, type, success: false, error: 'Evidence runtime is unavailable' };
  const input = payloadRecord(payload);

  switch (type) {
    case 'api:evidence/project:get':
      return {
        id,
        type,
        success: true,
        data: await runtime.getEvidenceProjectSetting(
          requiredString(input.directory, 'Directory'),
        ),
      };
    case 'api:evidence/project:set':
      return {
        id,
        type,
        success: true,
        data: await runtime.setEvidenceProjectSetting(
          requiredString(input.directory, 'Directory'),
          input.enabled === true,
        ),
      };
    case 'api:evidence/project:clear':
      return {
        id,
        type,
        success: true,
        data: {
          removed: await runtime.clearProjectEvidence(
            requiredString(input.directory, 'Directory'),
          ),
        },
      };
    case 'api:evidence:turns':
      return {
        id,
        type,
        success: true,
        data: await runtime.listEvidence(
          requiredString(input.sessionID, 'Session ID'),
          typeof input.directory === 'string' && input.directory.trim()
            ? input.directory.trim()
            : undefined,
          typeof input.userMessageID === 'string' && input.userMessageID.trim()
            ? input.userMessageID.trim()
            : undefined,
        ),
      };
    case 'api:evidence:diff':
      return {
        id,
        type,
        success: true,
        data: await runtime.getEvidenceDiff(
          requiredString(input.checkpointID, 'Checkpoint ID'),
          typeof input.file === 'string' ? input.file : undefined,
        ),
      };
    default:
      return { id, type, success: false, error: `Unknown evidence operation: ${type}` };
  }
}
