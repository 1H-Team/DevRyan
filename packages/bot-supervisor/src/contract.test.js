import { describe, expect, test } from 'bun:test';
import { BOT_ENGINE_OPERATIONS, BOT_RESOURCE_LIMITS, BotDockerError } from './contract.js';
import { createBotEngineProxyClient } from './engine-proxy-client.js';

describe('Bot engine contract', () => {
  test('the engine-proxy client speaks exactly the fixed operations', () => {
    const client = createBotEngineProxyClient({ endpoint: 'http://127.0.0.1:43124', token: 'a'.repeat(43) });
    expect(Object.keys(client)).toEqual([...BOT_ENGINE_OPERATIONS]);
    expect(BOT_ENGINE_OPERATIONS).toHaveLength(11);
  });

  test('keeps the resource limits and the error identity', () => {
    expect(BOT_RESOURCE_LIMITS).toEqual({
      reasoning: { memoryBytes: 2 * 1024 ** 3, nanoCpus: 2_000_000_000, pids: 256, shmBytes: 64 * 1024 ** 2 },
      computer: { memoryBytes: 3 * 1024 ** 3, nanoCpus: 2_000_000_000, pids: 512, shmBytes: 1024 ** 3 },
    });
    expect(Object.isFrozen(BOT_RESOURCE_LIMITS.reasoning)).toBe(true);
    const error = new BotDockerError('refused', 'bot_engine_proxy_unavailable', { statusCode: 503 });
    expect({ name: error.name, code: error.code, statusCode: error.statusCode }).toEqual({ name: 'BotDockerError', code: 'bot_engine_proxy_unavailable', statusCode: 503 });
  });

  test('is a dependency-free leaf the engine-proxy image can copy alone', async () => {
    const source = await Bun.file(new URL('./contract.js', import.meta.url)).text();
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
