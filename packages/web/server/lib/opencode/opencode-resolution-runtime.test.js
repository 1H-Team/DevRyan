import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeResolutionRuntime } from './opencode-resolution-runtime.js';

describe('OpenCode resolution runtime', () => {
  it('includes target install policy and detected runtime version in snapshots', async () => {
    const state = {
      resolvedOpencodeBinary: '/usr/local/bin/opencode',
      resolvedOpencodeBinarySource: 'path',
      useWslForOpencode: false,
      resolvedWslBinary: null,
      resolvedWslOpencodePath: null,
      resolvedWslDistro: null,
      resolvedNodeBinary: '/usr/bin/node',
      resolvedBunBinary: '/usr/bin/bun',
    };

    const runtime = createOpenCodeResolutionRuntime({
      path,
      resolveOpencodeCliPath: vi.fn(() => '/usr/local/bin/opencode'),
      applyOpencodeBinaryFromSettings: vi.fn(async () => {}),
      ensureOpencodeCliEnv: vi.fn(),
      resolveManagedOpenCodeLaunchSpec: vi.fn(() => null),
      getResolvedState: vi.fn(() => state),
      setResolvedOpencodeBinarySource: vi.fn((source) => {
        state.resolvedOpencodeBinarySource = source;
      }),
      getDetectedOpenCodeVersion: vi.fn(() => '1.18.18'),
    });

    const snapshot = await runtime.getOpenCodeResolutionSnapshot({});

    expect(snapshot).toMatchObject({
      targetVersion: '1.18.18',
      detectedVersion: '1.18.18',
      installCommand: 'curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.18 --no-modify-path',
    });
  });
});
