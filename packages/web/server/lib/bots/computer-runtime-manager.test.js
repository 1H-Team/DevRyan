import { describe, expect, it, vi } from 'vitest';

import { createBotComputerRuntimeManager } from './computer-runtime-manager.js';
import { createDockerBotComputerBackend } from './computer-backend.js';

const BOT_A = 'b0000000-0000-4000-8000-000000000001';
const BOT_B = 'b0000000-0000-4000-8000-000000000002';
const REVISION = 'f0000000-0000-4000-8000-000000000001';
const USER = 'a0000000-0000-4000-8000-000000000001';

const bot = (id) => ({
  id, lifecycle: 'active', active_revision_id: REVISION, created_by: USER,
});

describe('Active Bot computer runtime manager', () => {
  it('starts every Active Bot, isolates failures, restarts stopped computers, and stops on shutdown', async () => {
    const rows = [bot(BOT_A), bot(BOT_B)];
    const states = new Map([[BOT_A, 'absent'], [BOT_B, 'absent']]);
    let tokenByte = 6;
    const dockerProvider = {
      ensureComputer: vi.fn(async ({ botId }) => {
        if (botId === BOT_B) throw Object.assign(new Error('broken'), { code: 'bot_fixture_failed' });
        states.set(botId, 'running');
        return { endpoint: { baseUrl: 'http://127.0.0.1:49152' } };
      }),
      inspectComputer: vi.fn(async ({ botId }) => ({ state: states.get(botId) || 'absent' })),
      stopComputer: vi.fn(async ({ botId }) => {
        states.set(botId, 'stopped');
        return { state: 'stopped', name: `computer-${botId}` };
      }),
    };
    const manager = createBotComputerRuntimeManager({
      store: { repositories: { bots: {
        get: vi.fn(async ({ id }) => rows.find((entry) => entry.id === id) || null),
        list: vi.fn(async () => ({ items: rows, nextCursor: null })),
      }, bot_revisions: {
        get: vi.fn(async ({ id }) => ({
          id,
          contract: {
            browserPolicy: { networkAccess: { mode: 'public_only', hosts: [] } },
            computerPolicy: { isolationTier: 'standard' },
          },
        })),
      } } },
      computerBackend: createDockerBotComputerBackend({ dockerProvider }),
      gatewayHost: { getAddress: () => ({ dockerGatewayUrl: 'http://host.docker.internal:55100' }) },
      sweepIntervalMs: 60_000,
      randomBytesImpl: () => Buffer.alloc(32, ++tokenByte),
    });

    await manager.start();
    expect(manager.getRuntime(BOT_A)?.endpoint.baseUrl).toBe('http://127.0.0.1:49152');
    expect(dockerProvider.ensureComputer).toHaveBeenCalledWith(expect.objectContaining({
      browserNetworkMode: 'public_only',
      browserEgressHosts: [],
      isolationTier: 'standard',
    }));
    expect(manager.getFailure(BOT_B)?.code).toBe('bot_fixture_failed');

    const firstToken = manager.getRuntime(BOT_A).token;
    const restarted = await manager.restartBot(bot(BOT_A));
    expect(restarted.token).not.toBe(firstToken);
    expect(dockerProvider.stopComputer).toHaveBeenCalledWith(expect.objectContaining({ botId: BOT_A }));
    expect(dockerProvider.ensureComputer.mock.calls.filter(([input]) => input.botId === BOT_A))
      .toHaveLength(2);

    states.set(BOT_A, 'stopped');
    await manager.sweep();
    expect(dockerProvider.ensureComputer.mock.calls.filter(([input]) => input.botId === BOT_A)).toHaveLength(3);

    await manager.shutdown();
    expect(dockerProvider.stopComputer).toHaveBeenCalledWith(expect.objectContaining({ botId: BOT_A }));
  });
});
