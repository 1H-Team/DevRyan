import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { showSaveDialog: vi.fn() },
  workspace: { workspaceFolders: [] },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

import { handleDiagnosticsBridgeMessage } from './bridge-diagnostics-runtime';
import {
  setVsCodeHarnessRuntime,
  takeVsCodeHarnessRuntime,
} from './harness-runtime-access';
import type { VsCodeHarnessRuntime } from './harnessRuntime';

afterEach(() => {
  takeVsCodeHarnessRuntime();
});

describe('VS Code diagnostics bridge', () => {
  it('mirrors command deadline recovery status from the extension host', async () => {
    const commandDeadlineRecovery = {
      activeCount: 1,
      recoveredCount: 3,
      unresolvedCount: 1,
      lastOutcome: 'unresolved' as const,
      lastError: 'Other sessions are active',
      updatedAt: 123,
    };
    setVsCodeHarnessRuntime({
      async getStatus() {
        return {
          enabled: true,
          directory: '/diagnostics',
          diskBytes: 0,
          maxBytes: 1,
          segmentCount: 0,
          sessionCount: 0,
          queuedRecords: 0,
          writtenRecords: 0,
          gapRecords: 0,
          lastError: null,
          commandDeadlineRecovery,
        };
      },
    } as VsCodeHarnessRuntime);

    const response = await handleDiagnosticsBridgeMessage({
      id: 'request-1',
      type: 'api:diagnostics/status',
    });

    expect(response).toEqual({
      id: 'request-1',
      type: 'api:diagnostics/status',
      success: true,
      data: expect.objectContaining({ commandDeadlineRecovery }),
    });
  });
});
