import type {
  DiagnosticsAPI,
  DiagnosticsExportScope,
  DiagnosticsStatus,
} from '@openchamber/ui/lib/api/types';
import { sendBridgeMessage } from './bridge';

export const createVSCodeDiagnosticsAPI = (): DiagnosticsAPI => ({
  getStatus: () => sendBridgeMessage<DiagnosticsStatus>('api:diagnostics/status'),
  export: (scope: DiagnosticsExportScope) => sendBridgeMessage(
    'api:diagnostics/export',
    scope,
  ),
  sanitizeText: async (text: string) => {
    const result = await sendBridgeMessage<{ text: string }>('api:diagnostics/sanitize', { text });
    return result.text;
  },
  clear: () => sendBridgeMessage<DiagnosticsStatus>('api:diagnostics/clear'),
});
