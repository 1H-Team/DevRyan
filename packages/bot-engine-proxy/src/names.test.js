import { describe, expect, test } from 'bun:test';
import {
  BOT_RESOURCE_PREFIX,
  buildBotOwnershipLabels,
  deriveBotResourceNames,
} from './names.js';

const identity = {
  deploymentId: 'deployment-01',
  botId: 'bot-01',
  scopeKey: 'channel:channel-01',
  kind: 'reasoning',
};

describe('Bot supervisor resource names', () => {
  test('derives deterministic opaque Docker names and stable named volumes', () => {
    const first = deriveBotResourceNames(identity);
    const second = deriveBotResourceNames({ ...identity });

    expect(first).toEqual(second);
    expect(first.container.startsWith(`${BOT_RESOURCE_PREFIX}-reasoning-`)).toBe(true);
    expect(first.container).not.toContain(identity.botId);
    expect(first.volumes.workspace).toEndWith('-workspace');
    expect(first.scopeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('separates kinds and scopes', () => {
    const reasoning = deriveBotResourceNames(identity);
    const computer = deriveBotResourceNames({
      ...identity,
      kind: 'computer',
      scopeKey: 'bot:bot-01',
    });
    expect(reasoning.container).not.toBe(computer.container);
    expect(Object.keys(computer.volumes).sort()).toEqual(['profile', 'scratch', 'shared']);
    expect(reasoning.volumes.shared).toBe(computer.volumes.shared);
  });

  test('builds complete ownership labels and rejects unknown identity fields', () => {
    const labels = buildBotOwnershipLabels({ ...identity, imageIdentity: 'sha256:abc12345' });
    expect(labels).toMatchObject({
      'devryan.runtime': 'production-bots',
      'devryan.deployment': identity.deploymentId,
      'devryan.bot': identity.botId,
      'devryan.kind': 'reasoning',
      'devryan.image': 'sha256:abc12345',
    });
    expect(() => deriveBotResourceNames({ ...identity, extra: true }))
      .toThrow('identity shape is invalid');
  });
});
