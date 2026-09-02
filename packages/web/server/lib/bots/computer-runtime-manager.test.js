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

const storeFor = (rows) => ({ repositories: { bots: {
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
} } });

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

    const inspectionsBeforeHotEnsure = dockerProvider.inspectComputer.mock.calls.length;
    await manager.ensureBot(bot(BOT_A));
    expect(dockerProvider.inspectComputer).toHaveBeenCalledTimes(inspectionsBeforeHotEnsure);

    const firstToken = manager.getRuntime(BOT_A).token;
    const restarted = await manager.restartBot(bot(BOT_A));
    // A recovery restart keeps the capability so the persistent computer is reused.
    expect(restarted.token).toBe(firstToken);
    expect(dockerProvider.stopComputer).toHaveBeenCalledWith(expect.objectContaining({ botId: BOT_A }));
    expect(dockerProvider.ensureComputer.mock.calls.filter(([input]) => input.botId === BOT_A))
      .toHaveLength(2);
    expect(dockerProvider.ensureComputer.mock.calls.at(-1)[0].runtimeToken).toBe(firstToken);

    // Only an explicit rotation mints a new capability (and recreates the container).
    const rotated = await manager.restartBot(bot(BOT_A), { rotate: true });
    expect(rotated.token).not.toBe(firstToken);
    expect(dockerProvider.ensureComputer.mock.calls.at(-1)[0].runtimeToken).toBe(rotated.token);
    expect(() => manager.restartBot(bot(BOT_A), { rotate: 'yes' })).toThrow(TypeError);

    states.set(BOT_A, 'stopped');
    await manager.sweep();
    expect(dockerProvider.inspectComputer.mock.calls.length)
      .toBeGreaterThan(inspectionsBeforeHotEnsure);
    expect(dockerProvider.ensureComputer.mock.calls.filter(([input]) => input.botId === BOT_A)).toHaveLength(4);
    // The sweep's re-ensure after a stop keeps the current (rotated) token.
    expect(dockerProvider.ensureComputer.mock.calls.filter(([input]) => input.botId === BOT_A).at(-1)[0]
      .runtimeToken).toBe(rotated.token);

    await manager.shutdown();
    expect(dockerProvider.stopComputer).toHaveBeenCalledWith(expect.objectContaining({ botId: BOT_A }));
  });

  it('derives a stable runtime token from the deployment key so a DevRyan restart reuses the computer', async () => {
    const deploymentKey = Buffer.alloc(32, 7);
    const randomToken = Buffer.alloc(32, 9).toString('base64url');
    const createManager = ({ getKey = async () => Buffer.from(deploymentKey), ensured = [] } = {}) => {
      const dockerProvider = {
        ensureComputer: vi.fn(async (input) => {
          ensured.push(input.runtimeToken);
          return { endpoint: { baseUrl: 'http://127.0.0.1:49152' } };
        }),
        inspectComputer: vi.fn(async () => ({ state: 'running' })),
        stopComputer: vi.fn(async ({ botId }) => ({ state: 'stopped', name: `computer-${botId}` })),
      };
      const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
      const manager = createBotComputerRuntimeManager({
        store: storeFor([bot(BOT_A), bot(BOT_B)]),
        computerBackend: createDockerBotComputerBackend({ dockerProvider }),
        gatewayHost: { getAddress: () => ({ dockerGatewayUrl: 'http://host.docker.internal:55100' }) },
        sweepIntervalMs: 60_000,
        randomBytesImpl: () => Buffer.alloc(32, 9),
        encryption: { getKey },
        logger,
      });
      return { manager, dockerProvider, logger };
    };

    const firstStart = [];
    const first = createManager({ ensured: firstStart });
    const runtime = await first.manager.ensureBot(bot(BOT_A));
    expect(runtime.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(runtime.token).not.toBe(randomToken);
    expect(firstStart).toEqual([runtime.token]);

    // A brand-new manager (DevRyan restarted) with the same deployment key ensures
    // the container with the very same capability, so nothing is recreated.
    const secondStart = [];
    const second = createManager({ ensured: secondStart });
    expect((await second.manager.ensureBot(bot(BOT_A))).token).toBe(runtime.token);
    expect(secondStart).toEqual([runtime.token]);
    expect((await second.manager.restartBot(bot(BOT_A))).token).toBe(runtime.token);
    expect(second.logger.warn).not.toHaveBeenCalled();

    // Different Bots and different deployment keys never share a token.
    expect((await second.manager.ensureBot(bot(BOT_B))).token).not.toBe(runtime.token);
    const rekeyed = createManager({ getKey: async () => Buffer.alloc(32, 8) });
    expect((await rekeyed.manager.ensureBot(bot(BOT_A))).token).not.toBe(runtime.token);

    // Without a usable deployment key the manager falls back to a per-start token.
    const unsealed = createManager({
      getKey: async () => {
        throw Object.assign(new Error('sealed'), { code: 'bot_os_encryption_unavailable' });
      },
    });
    expect((await unsealed.manager.ensureBot(bot(BOT_A))).token).toBe(randomToken);
    expect(unsealed.logger.warn).toHaveBeenCalledTimes(1);
    const nullKey = createManager({ getKey: null });
    expect((await nullKey.manager.ensureBot(bot(BOT_A))).token).toBe(randomToken);
    const shortKey = createManager({ getKey: async () => Buffer.alloc(8, 1) });
    expect((await shortKey.manager.ensureBot(bot(BOT_A))).token).toBe(randomToken);

    expect(() => createBotComputerRuntimeManager({
      store: storeFor([]),
      computerBackend: createDockerBotComputerBackend({ dockerProvider: first.dockerProvider }),
      gatewayHost: { getAddress: () => null },
      encryption: { getKey: 'not-a-function' },
    })).toThrow(TypeError);
  });
});
